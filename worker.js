/**
 * AETHERIA Sub-Master 双 Bot 自动化订阅分销系统
 * Cloudflare Workers + KV + Telegram 双 Bot + Cron
 * 前台售卖 Bot / 后台管理 Bot / 买家网页门户 / 分销 / 卡密 / 优惠券 / 到期提醒 / 每日日报 / 套餐管理
 */

// ==================== 配置区 ====================
let ADMIN_BOT_TOKEN = "YOUR_ADMIN_BOT_TOKEN";
let STORE_BOT_TOKEN = "YOUR_STORE_BOT_TOKEN";
let ADMIN_ID = 0;
let DEFAULT_BRAND = "Maybe";
let DEFAULT_UPSTREAM_URL = "YOUR_DEFAULT_UPSTREAM_URL";
let STORE_ORIGIN = "";
let STORE_BOT_USERNAME = "";
let SETUP_KEY = "";

const DEFAULT_DAYS = 30;                     // 默认套餐天数
const REMINDER_DAYS = [3, 1, 0];             // 到期前 3/1/0 天提醒
const BOT_USERNAME_FALLBACK = "zzgmdybot";   // 兜底 Bot 用户名
const TG_API = "https://api.telegram.org/bot";

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

const getStoreBotUsername = () => STORE_BOT_USERNAME || BOT_USERNAME_FALLBACK;

function getStoreOrigin(request) {
  if (STORE_ORIGIN) return STORE_ORIGIN;
  try { return new URL(request.url).origin; } catch (e) { return ""; }
}

// 默认套餐（可在管理端「📦 套餐管理」中增删改/启停，存 KV plans_config）
const DEFAULT_PLANS = [
  { id: "month", name: "月卡", days: 30, price: "30元", enabled: true },
  { id: "quarter", name: "季卡", days: 90, price: "75元", enabled: true },
  { id: "year", name: "年卡", days: 365, price: "240元", enabled: true }
];

// ==================== Telegram API 封装 ====================
async function tg(token, method, payload) {
  try {
    const res = await fetch(`${TG_API}${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (e) { return {}; }
}

const sendText = (token, chatId, text) => tg(token, "sendMessage", { chat_id: chatId, text, parse_mode: "Markdown" });
const sendMenu = (token, chatId, text, replyMarkup) => tg(token, "sendMessage", { chat_id: chatId, text, reply_markup: replyMarkup, parse_mode: "Markdown" });

async function editMsg(token, chatId, messageId, text, replyMarkup) {
  const body = { chat_id: chatId, message_id: messageId, text, parse_mode: "Markdown" };
  if (replyMarkup) body.reply_markup = replyMarkup;
  return tg(token, "editMessageText", body);
}

const delMsg = (token, chatId, messageId) => tg(token, "deleteMessage", { chat_id: chatId, message_id: messageId });
const answerCb = (token, cbId, text) => tg(token, "answerCallbackQuery", { callback_query_id: cbId, text, show_alert: false });

// 分块发送卡密/优惠券代码
async function sendCodes(token, chatId, codes, header) {
  let chunk = "";
  for (let i = 0; i < codes.length; i++) {
    chunk += codes[i] + "\n";
    if ((i + 1) % 10 === 0 || i === codes.length - 1) {
      await sendText(token, chatId, (header ? header + "\n" : "") + "```\n" + chunk.trim() + "\n```");
      chunk = "";
    }
  }
}

// 底部常驻菜单
const STORE_MENU = {
  keyboard: [
    [{ text: "🛒 购买套餐" }, { text: "🔍 查询订阅" }],
    [{ text: "🎫 兑换卡密" }, { text: "🎁 优惠券" }],
    [{ text: "❓ 常见问题" }, { text: "📞 联系客服" }]
  ],
  resize_keyboard: true,
  persistent: true
};

const MAIN_MENU = {
  keyboard: [
    [{ text: "➕ 手动开卡" }, { text: "📋 用户列表" }],
    [{ text: "🔎 搜索用户" }, { text: "📊 用户统计" }],
    [{ text: "⏳ 即将到期" }, { text: "📤 导出名单" }],
    [{ text: "📦 订单管理" }, { text: "🎫 卡密管理" }],
    [{ text: "📦 套餐管理" }, { text: "⚙️ 系统设置" }],
    [{ text: "💰 分销系统" }, { text: "📣 群发通知" }],
    [{ text: "📊 系统概览" }, { text: "📜 操作日志" }],
    [{ text: "❓ 帮助说明" }]
  ],
  resize_keyboard: true,
  persistent: true
};

const CANCEL_BTN = { inline_keyboard: [[{ text: "❌ 取消", callback_data: "cancel_action" }]] };

// 天数快捷选择键盘（prefix: 回调前缀）
function daysBtns(prefix) {
  return {
    inline_keyboard: [
      [{ text: "7 天", callback_data: `${prefix}_7` }, { text: "30 天", callback_data: `${prefix}_30` }],
      [{ text: "90 天", callback_data: `${prefix}_90` }, { text: "365 天", callback_data: `${prefix}_365` }],
      [{ text: "✏️ 自定义", callback_data: `${prefix}_custom` }],
      [{ text: "❌ 取消", callback_data: "cancel_action" }]
    ]
  };
}

// ==================== KV / 通用工具 ====================
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

async function genUniqueUid(env) {
  for (let i = 0; i < 5; i++) {
    const uid = Math.floor(10000000 + Math.random() * 89999999).toString();
    if (!(await env.SUB_STORE.get(`user_${uid}`))) return uid;
  }
  return Math.floor(10000000 + Math.random() * 89999999).toString() + Date.now().toString().slice(-2);
}

const genOrderId = () => "ORD-" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();

// chatId 反向索引
async function indexUserChatId(env, chatId, uid) {
  if (!chatId || !uid) return;
  await env.SUB_STORE.put(`chatIdx_${chatId}`, uid);
}

async function findUidByChatId(env, chatId) {
  const idx = await env.SUB_STORE.get(`chatIdx_${chatId}`);
  if (idx) return idx;
  const keys = await listAllKeys(env, "user_", 5000);
  for (const k of keys) {
    try {
      const u = JSON.parse(await env.SUB_STORE.get(k));
      if (u.chatId === chatId) {
        const uid = k.replace("user_", "");
        await indexUserChatId(env, chatId, uid);
        return uid;
      }
    } catch (e) {}
  }
  return null;
}

async function unindexUserChatId(env, chatId) {
  if (chatId) await env.SUB_STORE.delete(`chatIdx_${chatId}`);
}

async function clearUserCache(env, uid) {
  for (const k of await listAllKeys(env, `cache_${uid}`, 10)) {
    if (k === `cache_${uid}` || k.startsWith(`cache_${uid}_`)) {
      try { await env.SUB_STORE.delete(k); } catch (e) {}
    }
  }
}

async function clearAllCache(env) {
  const cacheKeys = await listAllKeys(env, "cache_", 10000);
  for (const k of cacheKeys) await env.SUB_STORE.delete(k);
}

async function rateLimit(env, scope, chatId, seconds = 5) {
  const key = `rl_${scope}_${chatId}`;
  const last = await env.SUB_STORE.get(key);
  const now = Date.now();
  if (last && (now - parseInt(last)) < seconds * 1000) return false;
  try {
    await env.SUB_STORE.put(key, now.toString(), { expirationTtl: Math.max(seconds, 60) });
  } catch (e) {
    try { await env.SUB_STORE.put(key, now.toString()); } catch (e2) {}
  }
  return true;
}

async function logAction(env, action, detail) {
  try {
    const key = `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    await env.SUB_STORE.put(key, JSON.stringify({ action, detail, time: Date.now() }), { expirationTtl: 2592000 });
    const logs = await env.SUB_STORE.list({ prefix: "log_", limit: 300 });
    if (logs.keys.length > 250) {
      for (const k of logs.keys.slice(0, logs.keys.length - 200)) await env.SUB_STORE.delete(k.name);
    }
  } catch (e) {}
}

// 客服链接构建
function buildServiceLink(contact) {
  if (contact && contact.startsWith("@")) return `tg://resolve?domain=${contact.replace("@", "")}`;
  if (contact && contact.startsWith("http")) return contact;
  return `tg://resolve?domain=${getStoreBotUsername()}`;
}

// HTML 转义（防存储型 XSS）
function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// 提取字符串中第一个金额数字（如 "30元/月，年付240元" → 30）
function extractAmount(str) {
  const m = String(str ?? "").match(/\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
}

// ==================== 套餐管理 ====================
async function getPlans(env) {
  const plansStr = await env.SUB_STORE.get("plans_config");
  if (plansStr) {
    try {
      const arr = JSON.parse(plansStr);
      if (Array.isArray(arr) && arr.length > 0) return arr;
    } catch (e) {}
  }
  return DEFAULT_PLANS;
}

async function savePlans(env, plans) {
  await env.SUB_STORE.put("plans_config", JSON.stringify(plans));
}

// 买家可见套餐（仅启用）
async function getActivePlans(env) {
  const plans = await getPlans(env);
  return plans.filter(p => p.enabled !== false);
}

// 套餐管理面板（编辑消息/发送用）
function planManageMarkup(plans) {
  const rows = [];
  for (const p of plans) {
    rows.push([
      { text: `${p.enabled !== false ? "🟢" : "🔴"} ${p.name} (${p.days}天 / ${p.price})`, callback_data: `plans_toggle_${p.id}` },
      { text: "🗑️", callback_data: `plans_del_${p.id}` }
    ]);
  }
  rows.push([{ text: "➕ 添加套餐", callback_data: "plans_add" }]);
  return { inline_keyboard: rows };
}

async function showPlanManage(env, chatId, messageId) {
  const plans = await getPlans(env);
  const text = `📦 【套餐管理】\n\n当前 ${plans.length} 个套餐：\n` +
    plans.map((p, i) => `${i + 1}. ${p.enabled !== false ? "🟢" : "🔴"} ${p.name} | ${p.days} 天 | ${p.price}`).join("\n") +
    `\n\n点击套餐名称切换启用/停用（停用后买家不可见）\n点击 🗑️ 删除（至少保留 1 个）`;
  if (messageId) {
    await editMsg(ADMIN_BOT_TOKEN, chatId, messageId, text, planManageMarkup(plans));
  } else {
    await sendMenu(ADMIN_BOT_TOKEN, chatId, text, planManageMarkup(plans));
  }
}

// ==================== 上游池 ====================
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

const saveUpstreamPool = (env, pool) => env.SUB_STORE.put("upstream_list", JSON.stringify(pool));

async function getUpstreamForUser(env, uid, user) {
  const active = (await getUpstreamPool(env)).filter(u => u.status === "active");
  if (user.upstreamUrl && active.some(u => u.url === user.upstreamUrl)) return user.upstreamUrl;
  if (active.length === 0) return null;
  let hash = 0;
  for (const ch of String(uid)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return active[hash % active.length].url;
}

async function getDefaultUpstream(env) {
  const pool = await getUpstreamPool(env);
  const def = pool.find(u => u.isDefault && u.status === "active");
  if (def) return def.url;
  const active = pool.filter(u => u.status === "active");
  return active.length > 0 ? active[0].url : null;
}

async function addUpstream(env, url, note) {
  const pool = await getUpstreamPool(env);
  if (pool.some(u => u.url === url)) return { ok: false, msg: "该上游已存在" };
  const first = pool.length === 0;
  pool.push({ url, note: note || `上游${pool.length + 1}`, status: "active", addedAt: Date.now(), isDefault: first });
  await saveUpstreamPool(env, pool);
  return { ok: true, msg: `已添加，当前共 ${pool.length} 个上游`, index: pool.length - 1, isDefault: first };
}

async function removeUpstream(env, index) {
  const pool = await getUpstreamPool(env);
  if (isNaN(index) || index < 0 || index >= pool.length) return { ok: false, msg: "序号无效" };
  const removed = pool.splice(index, 1)[0];
  if (removed.isDefault && pool.length > 0) pool[0].isDefault = true;
  await saveUpstreamPool(env, pool);
  return { ok: true, msg: `已删除: ${removed.note || removed.url.slice(0, 30)}` };
}

async function setDefaultUpstream(env, index) {
  const pool = await getUpstreamPool(env);
  if (isNaN(index) || index < 0 || index >= pool.length) return { ok: false, msg: "序号无效" };
  pool.forEach((u, i) => { u.isDefault = (i === index); });
  await saveUpstreamPool(env, pool);
  return { ok: true, msg: `已将第 ${index + 1} 个设为默认` };
}

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

const saveNodeBlacklist = (env, list) => env.SUB_STORE.put("node_blacklist", JSON.stringify(list));

async function isMergeMode(env) {
  return (await env.SUB_STORE.get("merge_mode")) === "on";
}

// 提取节点行的 host 键（vmess 需解码 base64 取 add，其余取 hostname:port）
function extractHostKey(line) {
  const basePart = line.split("#")[0];
  let host = null;
  let port = "";
  if (basePart.startsWith("vmess://")) {
    try {
      let j = basePart.slice("vmess://".length);
      const pad = 4 - (j.length % 4);
      if (pad < 4) j += "=".repeat(pad);
      j = new TextDecoder().decode(Uint8Array.from(atob(j), c => c.charCodeAt(0)));
      const vm = JSON.parse(j);
      host = vm.add || null;
      port = vm.port ? String(vm.port) : "";
    } catch (e) { host = null; }
  }
  if (!host) {
    try {
      const u = new URL(basePart.includes("://") ? basePart : "http://" + basePart);
      host = u.hostname;
      port = u.port || "";
    } catch (e) { host = basePart; }
  }
  return host + ":" + port;
}

// 拉取并解析上游节点（base64 自动解码）
async function fetchUpstreamNodes(env, upstreamUrl) {
  const res = await fetch(upstreamUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
  });
  if (!res.ok) return { ok: false, nodes: [] };
  let decoded = (await res.text()).trim();
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
    let origName = parts[1] || "Node";
    if (parts[1]) { try { origName = decodeURIComponent(parts[1]); } catch (e) {} }
    nodes.push({ host: extractHostKey(line), name: origName, raw: line });
  }
  return { ok: true, nodes };
}

// 合并拉取所有活跃上游节点（完全相同的行去重）
async function fetchAllUpstreamsMerged(env) {
  const active = (await getUpstreamPool(env)).filter(u => u.status === "active");
  const seenLines = new Set();
  const mergedNodes = [];
  const results = await Promise.allSettled(active.map(up => fetchUpstreamNodes(env, up.url)));
  for (const r of results) {
    if (r.status !== "fulfilled" || !r.value.ok) continue;
    for (const node of r.value.nodes) {
      if (seenLines.has(node.raw)) continue;
      seenLines.add(node.raw);
      mergedNodes.push(node);
    }
  }
  return mergedNodes;
}

// 批量启用/禁用节点
async function batchToggleNodes(env, action, nodeIdxList, upIdx) {
  const pool = await getUpstreamPool(env);
  if (upIdx < 0 || upIdx >= pool.length) return { ok: false, msg: "上游序号无效" };
  const result = await fetchUpstreamNodes(env, pool[upIdx].url);
  if (!result.ok) return { ok: false, msg: "上游拉取失败" };

  let idxList = nodeIdxList === "all"
    ? result.nodes.map((_, i) => i + 1)
    : nodeIdxList.split(",").map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n >= 1 && n <= result.nodes.length);
  if (idxList.length === 0) return { ok: false, msg: "没有有效的节点序号" };

  let blacklist = await getNodeBlacklist(env);
  let done = 0, skipped = 0;
  const affected = [];
  for (const idx of idxList) {
    const node = result.nodes[idx - 1];
    const inList = blacklist.includes(node.host);
    if (action === "off") {
      if (!inList) { blacklist.push(node.host); done++; affected.push(node.host); }
      else skipped++;
    } else {
      if (inList) { blacklist = blacklist.filter(h => h !== node.host); done++; affected.push(node.host); }
      else skipped++;
    }
  }
  await saveNodeBlacklist(env, blacklist);
  if (done > 0) await clearAllCache(env);
  return { ok: true, done, skipped, affected, action };
}

// ==================== Clash YAML 生成 ====================
function generateClashYAML(nodes, brand, uid) {
  const proxies = [];
  for (const line of nodes) {
    const l = line.trim();
    if (!l || !l.includes("://")) continue;
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
        if (enc.includes("mlkem768x25519plus")) continue;
        const proxy = {
          name, type: "vless", server: u.hostname,
          port: u.port ? parseInt(u.port) : 443,
          uuid: u.username,
          network: params.get("type") || "tcp",
          tls: params.get("security") === "reality" || params.get("security") === "tls",
          servername: params.get("sni") || u.hostname,
          "client-fingerprint": params.get("fp") || "chrome",
          "reality-opts": { "public-key": params.get("pbk") || "", "short-id": params.get("sid") || "" }
        };
        if (params.get("flow")) proxy.flow = params.get("flow");
        if (params.get("headerType") && params.get("headerType") !== "none") proxy["header-type"] = params.get("headerType");
        if (params.get("path")) {
          proxy["ws-opts"] = { path: params.get("path") };
          if (params.get("host")) proxy["ws-opts"].headers = { Host: params.get("host") };
        }
        proxies.push(proxy);
      }
      else if (urlPart.startsWith("hysteria2://")) {
        const params = u.searchParams;
        const proxy = {
          name, type: "hysteria2", server: u.hostname,
          port: u.port ? parseInt(u.port) : 443,
          password: u.username,
          "skip-cert-verify": params.get("insecure") === "1"
        };
        if (params.get("sni")) proxy.sni = params.get("sni");
        if (params.get("obfs")) {
          proxy.obfs = params.get("obfs");
          if (params.get("obfs-password")) proxy["obfs-password"] = decodeURIComponent(params.get("obfs-password"));
        }
        proxies.push(proxy);
      }
      else if (urlPart.startsWith("vmess://")) {
        try {
          let jsonStr = urlPart.slice("vmess://".length);
          if (jsonStr && !jsonStr.startsWith("{")) {
            try {
              const pad = 4 - (jsonStr.length % 4);
              if (pad < 4) jsonStr += "=".repeat(pad);
              jsonStr = new TextDecoder().decode(Uint8Array.from(atob(jsonStr), c => c.charCodeAt(0)));
            } catch (e) {}
          }
          const vm = JSON.parse(jsonStr);
          const proxy = {
            name, type: "vmess", server: vm.add || u.hostname,
            port: vm.port ? parseInt(vm.port) : 443,
            uuid: vm.id, alterId: vm.aid ? parseInt(vm.aid) : 0,
            cipher: vm.scy || "auto", network: vm.net || "tcp"
          };
          if (vm.tls) proxy.tls = vm.tls === "tls" ? true : vm.tls;
          if (vm.sni) proxy.servername = vm.sni;
          if (vm.host && proxy.network === "ws") proxy["ws-opts"] = { headers: { Host: vm.host } };
          if (vm.path && proxy.network === "ws") {
            proxy["ws-opts"] = proxy["ws-opts"] || {};
            proxy["ws-opts"].path = vm.path;
          }
          proxies.push(proxy);
        } catch (e) {}
      }
    } catch (e) {}
  }

  const groupName = `${brand || "Maybe"} 节点 [UID:${uid}]`;
  let yaml = `# ${groupName}\n# 由 AETHERIA 自动生成 (${new Date().toISOString()})\n\n`;
  yaml += `mixed-port: 7890\nallow-lan: false\nmode: rule\nlog-level: info\n\nproxies:\n`;
  for (const p of proxies) {
    yaml += `  - name: ${JSON.stringify(p.name)}\n`;
    for (const [k, v] of Object.entries(p)) {
      if (k === "name") continue;
      if (typeof v === "object" && v !== null) {
        yaml += `    ${k}:\n`;
        for (const [k2, v2] of Object.entries(v)) {
          if (typeof v2 === "object" && v2 !== null) {
            yaml += `      ${k2}:\n`;
            for (const [k3, v3] of Object.entries(v2)) yaml += `        ${k3}: ${JSON.stringify(v3)}\n`;
          } else yaml += `      ${k2}: ${JSON.stringify(v2)}\n`;
        }
      } else yaml += `    ${k}: ${JSON.stringify(v)}\n`;
    }
    yaml += "\n";
  }
  yaml += `proxy-groups:\n  - name: "🚀 节点选择"\n    type: select\n    proxies:\n`;
  for (const p of proxies) yaml += `      - ${JSON.stringify(p.name)}\n`;
  yaml += `  - name: "♻️ 自动选择"\n    type: url-test\n    url: "http://www.gstatic.com/generate_204"\n    interval: 300\n    proxies:\n`;
  for (const p of proxies) yaml += `      - ${JSON.stringify(p.name)}\n`;
  yaml += `rules:\n  - MATCH,🚀 节点选择\n`;
  return yaml;
}

// ==================== 优惠券 / 卡密 ====================
// 分块 base64 编码（避免大数组展开超出调用栈限制）
function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 32768) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 32768));
  }
  return btoa(bin);
}

function genCode(prefix) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = prefix + "-";
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 4; j++) code += chars[Math.floor(Math.random() * chars.length)];
    if (i < 2) code += "-";
  }
  return code;
}

// 生成不重复的券码/卡密（避免碰撞覆盖已存在数据）
async function genUniqueCode(env, prefix) {
  for (let i = 0; i < 10; i++) {
    const code = genCode(prefix);
    const exists = prefix === "MB"
      ? await env.SUB_STORE.get(`card_${code}`)
      : await env.SUB_STORE.get(`coupon_${code}`);
    if (!exists) return code;
  }
  return genCode(prefix);
}

async function genCoupons(env, count, days, discountPct, note) {
  const coupons = [];
  for (let i = 0; i < count; i++) {
    const coupon = {
      code: await genUniqueCode(env, "CP"), days,
      discountPct, note: note || "优惠券",
      status: "unused", usedBy: null, usedAt: null, createdAt: Date.now()
    };
    await env.SUB_STORE.put(`coupon_${coupon.code}`, JSON.stringify(coupon), { expirationTtl: 7776000 });
    coupons.push(coupon);
  }
  return coupons;
}

async function genCards(env, count, days, planName, price) {
  const cards = [];
  const batchId = "B" + Date.now().toString(36).toUpperCase();
  for (let i = 0; i < count; i++) {
    const card = {
      code: await genUniqueCode(env, "MB"), days,
      planName: planName || `${days} 天套餐`, price: price || "",
      status: "unused", usedBy: null, usedAt: null, batchId, createdAt: Date.now()
    };
    await env.SUB_STORE.put(`card_${card.code}`, JSON.stringify(card), { expirationTtl: 15552000 });
    cards.push(card);
  }
  return cards;
}

// 兑换：创建/续费订阅（card/coupon 共用）
async function redeemCreateUser(env, chatId, days, planName, source) {
  const existingUid = await findUidByChatId(env, chatId);
  const now = Date.now();
  let finalUid, isRenew;
  if (existingUid) {
    finalUid = existingUid;
    const existing = JSON.parse(await env.SUB_STORE.get(`user_${existingUid}`));
    existing.expiry = Math.max(existing.expiry, now) + (days * 86400000);
    existing.status = "active";
    existing.plan = planName;
    delete existing.lastNotified;
    if (source) existing.source = source;
    await env.SUB_STORE.put(`user_${existingUid}`, JSON.stringify(existing));
    isRenew = true;
  } else {
    finalUid = await genUniqueUid(env);
    const upstream = await getDefaultUpstream(env);
    const user = {
      upstreamUrl: upstream, expiry: now + (days * 86400000), status: "active",
      brand: DEFAULT_BRAND, chatId, createdAt: now, plan: planName
    };
    if (source) user.source = source;
    await env.SUB_STORE.put(`user_${finalUid}`, JSON.stringify(user));
    await indexUserChatId(env, chatId, finalUid);
    isRenew = false;
  }
  return { finalUid, isRenew };
}

async function redeemCoupon(env, code, chatId) {
  const key = `coupon_${code}`;
  const couponStr = await env.SUB_STORE.get(key);
  if (!couponStr) return { ok: false, msg: "❌ 优惠券不存在或已过期" };
  const coupon = JSON.parse(couponStr);
  if (coupon.status === "used") return { ok: false, msg: "❌ 该优惠券已被使用" };

  const actualDays = Math.max(1, Math.round((coupon.days || 30) * (coupon.discountPct || 100) / 100));
  const { finalUid, isRenew } = await redeemCreateUser(env, chatId, actualDays, coupon.note || `${actualDays} 天`, "coupon");

  coupon.status = "used"; coupon.usedBy = chatId; coupon.usedAt = Date.now();
  await env.SUB_STORE.put(key, JSON.stringify(coupon));

  await env.SUB_STORE.put(`record_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, JSON.stringify({
    orderId: code, chatId, plan: coupon.note || `${actualDays} 天`, days: actualDays, price: "",
    time: Date.now(), uid: finalUid, type: isRenew ? "renew" : "new", via: "coupon"
  }), { expirationTtl: 15552000 });

  await creditReseller(env, chatId, "");
  return { ok: true, msg: "🎉 优惠券兑换成功", uid: finalUid, days: actualDays, plan: coupon.note, discount: coupon.discountPct };
}

async function redeemCard(env, code, chatId) {
  const key = `card_${code}`;
  const cardStr = await env.SUB_STORE.get(key);
  if (!cardStr) return { ok: false, msg: "❌ 卡密不存在或已失效" };
  const card = JSON.parse(cardStr);
  if (card.status === "used") return { ok: false, msg: "❌ 该卡密已被使用" };
  if (card.status === "disabled") return { ok: false, msg: "❌ 该卡密已被禁用" };

  const { finalUid, isRenew } = await redeemCreateUser(env, chatId, card.days, card.planName, "card");

  card.status = "used"; card.usedBy = chatId; card.usedAt = Date.now();
  await env.SUB_STORE.put(key, JSON.stringify(card));

  await env.SUB_STORE.put(`record_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, JSON.stringify({
    orderId: code, chatId, plan: card.planName, days: card.days, price: card.price,
    time: Date.now(), uid: finalUid, type: isRenew ? "renew" : "new", via: "card"
  }), { expirationTtl: 15552000 });

  await creditReseller(env, chatId, card.price);
  return { ok: true, msg: "🎉 兑换成功", uid: finalUid, days: card.days, plan: card.planName };
}

// ==================== 分销 ====================
async function setBuyerAffiliate(env, chatId, code) {
  if (!chatId || !code) return;
  await env.SUB_STORE.put(`aff_${chatId}`, code, { expirationTtl: 7776000 });
}

async function getBuyerAffiliate(env, chatId) {
  try {
    const code = await env.SUB_STORE.get(`aff_${chatId}`);
    if (!code) return null;
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

async function creditReseller(env, chatId, planPrice) {
  try {
    const aff = await getBuyerAffiliate(env, chatId);
    if (!aff) return;
    const parsedRate = parseFloat(await env.SUB_STORE.get("comm_rate"));
    const rate = Number.isFinite(parsedRate) ? parsedRate : 10;
    const priceNum = extractAmount(planPrice);
    if (isNaN(priceNum) || priceNum <= 0) return;
    const commission = +(priceNum * rate / 100).toFixed(2);
    if (commission <= 0) return;
    aff.reseller.commission = (aff.reseller.commission || 0) + commission;
    aff.reseller.orders = (aff.reseller.orders || 0) + 1;
    await env.SUB_STORE.put(aff.key, JSON.stringify(aff.reseller));
  } catch (e) {}
}

// ==================== 支付方式（微信/支付宝/USDT） ====================
async function getPayQrs(env, method) {
  const key = method === "wechat" ? "pay_qrs_wechat" : "pay_qrs_alipay";
  const str = await env.SUB_STORE.get(key);
  if (str) {
    try {
      const arr = JSON.parse(str);
      if (Array.isArray(arr) && arr.length > 0) return arr;
    } catch (e) {}
  }
  return [];
}

async function savePayQrs(env, method, list) {
  await env.SUB_STORE.put(method === "wechat" ? "pay_qrs_wechat" : "pay_qrs_alipay", JSON.stringify(list));
}

async function addPayQr(env, method, fileId) {
  const list = await getPayQrs(env, method);
  list.push({ fileId, addedAt: Date.now() });
  await savePayQrs(env, method, list);
  return list;
}

async function removePayQr(env, method, index) {
  const list = await getPayQrs(env, method);
  if (isNaN(index) || index < 0 || index >= list.length) return { ok: false, msg: "序号无效" };
  list.splice(index, 1);
  await savePayQrs(env, method, list);
  return { ok: true, msg: `已删除第 ${index + 1} 个` };
}

async function getUsdtInfo(env) {
  const str = await env.SUB_STORE.get("pay_usdt");
  if (str) {
    try {
      const obj = JSON.parse(str);
      if (obj && obj.address) return obj;
    } catch (e) {}
  }
  return null;
}

async function saveUsdtInfo(env, address, network) {
  await env.SUB_STORE.put("pay_usdt", JSON.stringify({ address, network: network || "TRC20", updatedAt: Date.now() }));
}

// USDT 汇率（1 USDT = N 人民币），未配置默认 7.2
async function getUsdtRate(env) {
  const str = await env.SUB_STORE.get("usdt_rate");
  if (str) {
    const r = parseFloat(str);
    if (r > 0) return r;
  }
  return 7.2;
}

async function saveUsdtRate(env, rate) {
  await env.SUB_STORE.put("usdt_rate", String(rate));
}

// 人民币金额 → USDT 金额（向上取整到 2 位小数，避免少收）
function cnyToUsdt(cny, rate) {
  if (!cny || cny <= 0) return null;
  return Math.ceil((cny / rate) * 100) / 100;
}

// 获取买家可见的可用支付方式列表
async function getAvailablePayMethods(env) {
  const methods = [];
  if ((await getPayQrs(env, "wechat")).length > 0) methods.push({ id: "wechat", label: "📱 微信", type: "qr" });
  if ((await getPayQrs(env, "alipay")).length > 0) methods.push({ id: "alipay", label: "🧧 支付宝", type: "qr" });
  if (await getUsdtInfo(env)) methods.push({ id: "usdt", label: "🪙 USDT", type: "text" });
  return methods;
}

// 支付方式标签
function payMethodLabel(id) {
  return id === "wechat" ? "📱 微信" : (id === "alipay" ? "🧧 支付宝" : (id === "usdt" ? "🪙 USDT" : id));
}

// 收款码跨 Bot 转换：管理 Bot file_id → 前台 Bot file_id
async function convertQRForStoreBot(adminFileId) {
  try {
    const fileRes = await fetch(`${TG_API}${ADMIN_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(adminFileId)}`);
    const fileJson = await fileRes.json();
    if (!fileJson.ok || !fileJson.result || !fileJson.result.file_path) return null;
    const imgRes = await fetch(`https://api.telegram.org/file/bot${ADMIN_BOT_TOKEN}/${fileJson.result.file_path}`);
    if (!imgRes.ok) return null;
    const imgBlob = await imgRes.blob();

    const formData = new FormData();
    formData.append("chat_id", String(ADMIN_ID));
    const fname = fileJson.result.file_path.split("/").pop() || "qr.jpg";
    formData.append("photo", imgBlob, fname);

    const sendRes = await fetch(`${TG_API}${STORE_BOT_TOKEN}/sendPhoto`, { method: "POST", body: formData });
    const sendJson = await sendRes.json().catch(() => ({}));
    if (sendJson.ok && sendJson.result && sendJson.result.photo && sendJson.result.photo.length > 0) {
      const storeFileId = sendJson.result.photo[sendJson.result.photo.length - 1].file_id;
      try {
        await fetch(`${TG_API}${STORE_BOT_TOKEN}/deleteMessage`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: ADMIN_ID, message_id: sendJson.result.message_id })
        });
      } catch (e) {}
      return storeFileId;
    }
    return null;
  } catch (e) { return null; }
}

// ==================== 用户操作面板（多入口共用） ====================
function opsButtons(uid) {
  return {
    inline_keyboard: [
      [
        { text: "🔴 禁用", callback_data: `disable_${uid}` },
        { text: "🟢 开启", callback_data: `enable_${uid}` },
        { text: "🗑️ 删除", callback_data: `del_${uid}` }
      ],
      [
        { text: "⏱️ 调整时长", callback_data: `pick_adjust_${uid}` },
        { text: "🎯 分配上游", callback_data: `assign_${uid}` }
      ],
      [
        { text: "📝 备注", callback_data: `pick_note_${uid}` },
        { text: "💬 私信", callback_data: `pick_msg_${uid}` }
      ],
      [
        { text: "↩️ 撤销删除", callback_data: `undel_${uid}` },
        { text: "🔗 订阅链接", callback_data: `link_${uid}` }
      ]
    ]
  };
}

function userSummary(u, uid) {
  const remainDays = Math.ceil((u.expiry - Date.now()) / 86400000);
  const stateDesc = u.status === "disabled" ? "🔴 禁用中" : (remainDays <= 0 ? "⏳ 已过期" : "🟢 正常运行");
  return { remainDays, stateDesc };
}

// 卡密列表（分页 + 操作按钮）
async function sendCardList(env, chatId, page, messageId) {
  const cardKeys = await listAllKeys(env, "card_", 10000);
  if (cardKeys.length === 0) {
    const msg = "📭 当前没有任何卡密\n点击「➕ 生成卡密」或 /gencard 生成";
    if (messageId) { await editMsg(ADMIN_BOT_TOKEN, chatId, messageId, msg, null); }
    else await sendMenu(ADMIN_BOT_TOKEN, chatId, msg, MAIN_MENU);
    return;
  }
  const perPage = 8;
  const totalPages = Math.max(1, Math.ceil(cardKeys.length / perPage));
  const p = Math.max(1, Math.min(page, totalPages));
  const pageKeys = cardKeys.slice((p - 1) * perPage, p * perPage);
  let text = `🎫 【卡密列表】(${cardKeys.length} 张 · 第 ${p}/${totalPages} 页)\n\n`;
  const rows = [];
  for (const k of pageKeys) {
    try {
      const c = JSON.parse(await env.SUB_STORE.get(k));
      const icon = c.status === "used" ? "🔵已用" : (c.status === "disabled" ? "🔴禁用" : "🟢未用");
      text += `• ${c.code} | ${icon} | ${c.days}天\n`;
      const btns = [{ text: "📋", callback_data: `card_lookup_${c.code}` }];
      if (c.status === "disabled") btns.push({ text: "🟢启用", callback_data: `enable_card_${c.code}` });
      else if (c.status !== "used") btns.push({ text: "🔴禁用", callback_data: `disable_card_${c.code}` });
      btns.push({ text: "🗑️删除", callback_data: `del_card_${c.code}` });
      rows.push(btns);
    } catch (e) {}
  }
  const nav = [];
  if (p > 1) nav.push({ text: "◀️ 上一页", callback_data: `card_list_page_${p - 1}` });
  if (p < totalPages) nav.push({ text: "下一页 ▶️", callback_data: `card_list_page_${p + 1}` });
  if (nav.length) rows.push(nav);
  const markup = { inline_keyboard: rows };
  if (messageId) {
    await editMsg(ADMIN_BOT_TOKEN, chatId, messageId, text, markup);
  } else {
    await sendMenu(ADMIN_BOT_TOKEN, chatId, text, markup);
  }
}

// 待审核订单列表（分页 + 处理按钮）
async function sendPendingOrders(env, chatId, page, messageId) {
  const orderKeys = await listAllKeys(env, "pending_", 2000);
  if (orderKeys.length === 0) {
    const msg = "📭 当前没有待审核订单";
    if (messageId) { await editMsg(ADMIN_BOT_TOKEN, chatId, messageId, msg, null); }
    else await sendMenu(ADMIN_BOT_TOKEN, chatId, msg, MAIN_MENU);
    return;
  }
  const perPage = 8;
  const totalPages = Math.max(1, Math.ceil(orderKeys.length / perPage));
  const p = Math.max(1, Math.min(page, totalPages));
  const pageKeys = orderKeys.slice((p - 1) * perPage, p * perPage);
  let text = `📦 【待审核订单】(${orderKeys.length} 单 · 第 ${p}/${totalPages} 页)\n\n`;
  const rows = [];
  for (const k of pageKeys) {
    try {
      const order = JSON.parse(await env.SUB_STORE.get(k));
      text += `• ${order.orderId || k.replace("pending_", "")} ${order.type === "renew" ? "🔄续费" : "🆕新购"} 买家:${order.chatId}\n  ${order.planName || "默认套餐"} ${order.planPrice || ""}\n`;
      rows.push([
        { text: "🟢 开通", callback_data: `approve_${order.chatId}_${order.orderId}` },
        { text: "🚫 取消订单", callback_data: `cancel_pending_${order.orderId}` }
      ]);
    } catch (e) {}
  }
  const nav = [];
  if (p > 1) nav.push({ text: "◀️ 上一页", callback_data: `pending_list_page_${p - 1}` });
  if (p < totalPages) nav.push({ text: "下一页 ▶️", callback_data: `pending_list_page_${p + 1}` });
  if (nav.length) rows.push(nav);
  if (messageId) {
    await editMsg(ADMIN_BOT_TOKEN, chatId, messageId, text, { inline_keyboard: rows });
  } else {
    await sendMenu(ADMIN_BOT_TOKEN, chatId, text, { inline_keyboard: rows });
  }
}

// ==================== 每日运营日报 ====================
async function sendDailyReport(env) {
  try {
    const recordKeys = await listAllKeys(env, "record_", 5000);
    const userKeys = await listAllKeys(env, "user_", 10000);
    const now = Date.now();
    const dayMs = 86400000;
    const nowD = new Date();
    const todayStart = Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), nowD.getUTCDate());

    let yesterdayNew = 0, yesterdayRenew = 0, yesterdayCard = 0, totalOrders = 0;
    for (const k of recordKeys) {
      const r = JSON.parse(await env.SUB_STORE.get(k));
      totalOrders++;
      if (r.time >= todayStart - dayMs && r.time < todayStart) {
        if (r.via === "card") yesterdayCard++;
        else if (r.type === "renew") yesterdayRenew++;
        else yesterdayNew++;
      }
    }

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

    let cardUnused = 0;
    for (const k of await listAllKeys(env, "card_", 10000)) {
      if (JSON.parse(await env.SUB_STORE.get(k)).status === "unused") cardUnused++;
    }

    const report = `📊 【每日运营日报】\n\n` +
      `📦 昨日新购: ${yesterdayNew} 单\n` +
      `🔄 昨日续费: ${yesterdayRenew} 单\n` +
      `🎫 昨日卡密: ${yesterdayCard} 单\n` +
      `🧾 历史总单: ${totalOrders} 笔\n\n` +
      `👥 当前用户: ${userKeys.length}\n` +
      `　🟢 正常: ${active} | ⏳ 过期: ${expired} | 🔴 禁用: ${disabled}\n` +
      `⚠️ 7天内到期: ${expiring7.length} 人\n` +
      `🎫 卡密库存: ${cardUnused} 张`;

    await sendText(ADMIN_BOT_TOKEN, ADMIN_ID, report);
  } catch (e) {}
}

// ==================== 到期提醒 ====================
async function checkExpiringSubscriptions(env) {
  const userKeys = await listAllKeys(env, "user_", 10000);
  const now = Date.now();
  const day = 86400000;
  const originBase = STORE_ORIGIN || "";

  for (const k of userKeys) {
    const uid = k.replace("user_", "");
    const u = JSON.parse(await env.SUB_STORE.get(k));
    if (u.status !== "active" || !u.chatId) continue;

    const remainMs = u.expiry - now;
    for (const remindDay of REMINDER_DAYS) {
      // 区间匹配避免重叠：d0=今天(0~1天), d1=1~2天, d3=3~4天
      const hit = remindDay === 0
        ? (remainMs >= 0 && remainMs < day)
        : (remainMs >= remindDay * day && remainMs < (remindDay + 1) * day);
      if (!hit) continue;
      const lastNotified = u.lastNotified || {};
      if (lastNotified[`d${remindDay}`]) continue;

      const msg = remindDay > 0
        ? `⏰ 【到期提醒】\n您的订阅将于 ${remindDay} 天后到期！\n\n请及时续费以免影响使用。\n\n📱 快速续费: ${originBase}/renew/${uid}`
        : `⏰ 【到期提醒】\n您的订阅今天到期！\n\n请尽快续费以免服务中断。\n\n📱 快速续费: ${originBase}/renew/${uid}`;
      const buyerSent = (await sendText(STORE_BOT_TOKEN, u.chatId, msg)).ok === true;
      if (!buyerSent) continue; // 买家通知失败不记录，下次 cron 重试
      await sendText(ADMIN_BOT_TOKEN, ADMIN_ID, `⏰ 【到期提醒】\n用户 UID:${uid} (ChatID:${u.chatId})\n剩余 ${remindDay} 天到期，已通知买家。`);

      lastNotified[`d${remindDay}`] = now;
      u.lastNotified = lastNotified;
      await env.SUB_STORE.put(k, JSON.stringify(u));
      break;
    }
  }
}

// ==================== 系统概览 ====================
async function buildOverview(env) {
  const userKeys = await listAllKeys(env, "user_", 10000);
  const pendingKeys = await listAllKeys(env, "pending_", 2000);
  const pool = await getUpstreamPool(env);
  const activeUp = pool.filter(u => u.status === "active");
  const days = await env.SUB_STORE.get("default_days") || DEFAULT_DAYS;
  const price = await env.SUB_STORE.get("price_info") || "未设置";
  const plans = await getPlans(env);

  let activeCount = 0, expiredCount = 0, disabledCount = 0;
  for (const k of userKeys) {
    const u = JSON.parse(await env.SUB_STORE.get(k));
    if (u.status === "disabled") disabledCount++;
    else if (Date.now() > u.expiry) expiredCount++;
    else activeCount++;
  }

  // 今日经营数据（按 UTC 0 点分界）
  const nowD = new Date();
  const todayStart = Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), nowD.getUTCDate());
  let todayNew = 0, todayRenew = 0, todayCard = 0, todayAmount = 0;
  for (const k of await listAllKeys(env, "record_", 5000)) {
    const r = JSON.parse(await env.SUB_STORE.get(k));
    if (r.time >= todayStart) {
      if (r.via === "card") todayCard++;
      else if (r.type === "renew") todayRenew++;
      else todayNew++;
      const n = extractAmount(r.price);
      if (!isNaN(n)) todayAmount += n;
    }
  }

  let cardUnused = 0;
  for (const k of await listAllKeys(env, "card_", 10000)) {
    if (JSON.parse(await env.SUB_STORE.get(k)).status === "unused") cardUnused++;
  }

  const mergeMode = await isMergeMode(env);
  return `📊 【系统运行大盘】\n\n` +
    `📈 今日经营: 新购 ${todayNew} | 续费 ${todayRenew} | 卡密 ${todayCard}\n` +
    `💰 今日流水: ${todayAmount.toFixed(2)} 元\n\n` +
    `👥 用户总数: ${userKeys.length}\n` +
    `　🟢 正常: ${activeCount} | ⏳ 过期: ${expiredCount} | 🔴 禁用: ${disabledCount}\n` +
    `📦 待审订单: ${pendingKeys.length}\n` +
    `🧾 订单流水: ${(await listAllKeys(env, "record_", 5000)).length} 笔\n` +
    `🎫 可用卡密: ${cardUnused} 张\n` +
    `📦 套餐: ${plans.length} 个 (${plans.filter(p => p.enabled !== false).length} 个在售)\n` +
    `💰 套餐价格: ${price}\n` +
    `📅 默认时长: ${days} 天\n` +
    `💳 支付方式: ${(await getAvailablePayMethods(env)).length > 0 ? (await getAvailablePayMethods(env)).map(m => m.label).join(" ") : "未配置 🔴"}\n` +
    `🔗 上游池: ${pool.length} 个 (可用 ${activeUp.length})\n` +
    `🔄 合并模式: ${mergeMode ? "✅ 开启" : "⭕ 关闭"}\n` +
    `⚡ 运行环境: Cloudflare Workers (Edge)\n` +
    `⏰ 到期提醒: 自动 (${REMINDER_DAYS.join("/")}天前)\n` +
    `🚀 状态: 运行正常`;
}

// ==================== 模块 1: 买家门户 /s/{uid} ====================
async function handleBuyerPortal(uid, request, env) {
  const userDataStr = await env.SUB_STORE.get(`user_${uid}`);
  if (!userDataStr) return new Response("【错误】订阅不存在或已失效", { status: 404 });

  const user = JSON.parse(userDataStr);
  const ua = request.headers.get("User-Agent") || "";
  const accept = request.headers.get("Accept") || "";
  const isBrowser = (ua.includes("Mozilla") || ua.includes("Chrome") || ua.includes("Safari")) && accept.includes("text/html");

  // ===== 浏览器访问 → 控制面板 =====
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
    const plan = escapeHtml(user.plan || "标准套餐");
    const price = escapeHtml(user.price || "");
    const serviceLink = buildServiceLink(await env.SUB_STORE.get("service_contact") || "");
    const notice = escapeHtml(await env.SUB_STORE.get("notice_content") || "");
    const createdAt = user.createdAt || user.expiry - (30 * 86400000);
    const createdDate = new Date(createdAt).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" });
    const sourceDesc = user.source === "card" ? "卡密兑换" : (user.source === "coupon" ? "优惠券" : "官方购买");
    const totalMs = Math.max(user.expiry - createdAt, 86400000);
    const progressPct = Math.max(0, Math.min(100, Math.round((1 - (user.expiry - Date.now()) / totalMs) * 100)));

    const noticeBanner = (notice && !disabled && !expired) ? `
    <div style="background:rgba(56,189,248,0.08);border:1px solid rgba(56,189,248,0.2);border-radius:12px;padding:12px;margin-bottom:16px;text-align:left;">
      <div style="color:#38bdf8;font-size:12px;font-weight:700;margin-bottom:4px;">📢 公告</div>
      <div style="color:#94a3b8;font-size:13px;line-height:1.6;">${notice}</div>
    </div>` : "";

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
  <title>${DEFAULT_BRAND} 专属节点服务</title>
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
        <div class="stat-value">${plan}${price ? ` (${price})` : ""}</div>
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
    ${disabled || expired ? "" : `
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
  if (user.status === "disabled") return new Response("【通知】您的服务已被管理员暂停，请联系客服处理。", { status: 403 });
  if (Date.now() > user.expiry) return new Response("【通知】您的服务套餐已过期，请续费后继续使用。", { status: 403 });

  // ===== 客户端访问 → 智能清洗、去重与缓存下发 =====
  const yamlMode = request.url.includes("yaml=1");
  const legacyMode = request.url.includes("legacy=1");
  const cacheKey = `cache_${uid}${legacyMode ? "_legacy" : ""}${yamlMode ? "_yaml" : ""}`;
  const cachedContent = await env.SUB_STORE.get(cacheKey);
  if (cachedContent) {
    return new Response(cachedContent, {
      headers: yamlMode
        ? {
          "Content-Type": "application/yaml; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Profile-Update-Interval": "24",
          "Subscription-Userinfo": `upload=0; download=0; total=0; expire=${Math.floor(user.expiry / 1000)}`,
          "Cache-Control": "no-store"
        }
        : {
          "Content-Type": "text/plain; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Profile-Update-Interval": "24",
          "Subscription-Userinfo": `upload=0; download=0; total=0; expire=${Math.floor(user.expiry / 1000)}`,
          "Cache-Control": "no-store"
        }
    });
  }

  const mergeMode = await isMergeMode(env);
  let nodeLines = [];

  if (mergeMode) {
    nodeLines = (await fetchAllUpstreamsMerged(env)).map(n => n.raw);
    if (nodeLines.length === 0) return new Response("上游池无可用节点，请联系管理员", { status: 502 });
  } else {
    const effectiveUpstream = await getUpstreamForUser(env, uid, user);
    if (!effectiveUpstream) return new Response("上游池暂无可用源，请联系管理员", { status: 502 });
    const upstreamRes = await fetch(effectiveUpstream, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
    });
    if (!upstreamRes.ok) return new Response("上游源异常，请稍后重试", { status: 502 });
    let decoded = (await upstreamRes.text()).trim();
    try {
      let b64 = decoded;
      const pad = 4 - (b64.length % 4);
      if (pad < 4) b64 += "=".repeat(pad);
      decoded = new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
    } catch (e) {}
    nodeLines = decoded.split("\n");
  }

  const processedNodes = [];
  const seenHosts = new Set();
  const seenRawLines = new Set();
  const counters = { "香港": 1, "日本": 1, "美国": 1, "新加坡": 1, "其他": 1 };
  const nodeBlacklist = await getNodeBlacklist(env);

  for (let line of nodeLines) {
    line = line.trim();
    if (!line || !line.includes("://")) continue;
    if (legacyMode && line.includes("mlkem768x25519plus")) continue;

    const parts = line.split("#");
    const basePart = parts[0];
    let origName = parts[1] || "Node";
    if (parts[1]) { try { origName = decodeURIComponent(parts[1]); } catch (e) {} }

    if (["官网", "测试", "过期", "到期"].some(kw => origName.includes(kw))) continue;
    ["上游", "机场", "aff", "www.", ".com", "TG@"].forEach(w => { origName = origName.split(w).join(""); });

    let region = "其他";
    if (["香港", "HK", "HongKong"].some(k => origName.includes(k))) region = "香港";
    else if (["日本", "JP", "东京"].some(k => origName.includes(k))) region = "日本";
    else if (["美国", "US", "United States"].some(k => origName.includes(k))) region = "美国";
    else if (["新加坡", "SG", "Singapore"].some(k => origName.includes(k))) region = "新加坡";

    let hostKey = extractHostKey(line);

    if (!mergeMode) {
      if (seenHosts.has(hostKey)) continue;
      seenHosts.add(hostKey);
    } else {
      if (seenRawLines.has(line)) continue;
      seenRawLines.add(line);
    }

    if (nodeBlacklist.includes(hostKey)) continue;

    const idx = counters[region]++;
    const formattedName = `${user.brand || DEFAULT_BRAND} · ${region} ${String(idx).padStart(2, "0")} [UID:${uid}]`;
    processedNodes.push(`${basePart}#${formattedName.split(" ").join("%20")}`);
  }

  const finalOutput = processedNodes.join("\n");

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

  const finalBase64 = bytesToBase64(new TextEncoder().encode(finalOutput));
  await env.SUB_STORE.put(cacheKey, finalBase64, { expirationTtl: 7200 });

  return new Response(finalBase64, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Profile-Update-Interval": "24",
      "Subscription-Userinfo": `upload=0; download=0; total=0; expire=${Math.floor(user.expiry / 1000)}`,
      "Cache-Control": "no-store"
    }
  });
}

// ==================== 模块 1.5: 续费页 /renew/{uid} ====================
async function handleRenewPage(uid, request, env) {
  const userDataStr = await env.SUB_STORE.get(`user_${uid}`);
  if (!userDataStr) return new Response("【错误】订阅不存在或已失效", { status: 404 });
  const user = JSON.parse(userDataStr);
  const chatId = user.chatId;
  const price = await env.SUB_STORE.get("price_info") || "联系客服获取";
  const days = await env.SUB_STORE.get("default_days") || DEFAULT_DAYS;
  const serviceLink = buildServiceLink(await env.SUB_STORE.get("service_contact") || "");

  // 过期或 7 天内到期才通知管理员（30 分钟内防抖）
  const remainDays = (user.expiry - Date.now()) / 86400000;
  const disabledUser = user.status === "disabled";
  if (user.status === "active" && remainDays <= 7 && chatId) {
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
        await tg(ADMIN_BOT_TOKEN, "sendMessage", {
          chat_id: ADMIN_ID,
          text: `🔄 【续费请求】\n• 用户 UID: ${uid}\n• ChatID: \`${chatId}\`\n• 剩余: ${Math.max(0, Math.ceil(remainDays))} 天\n• 请求续费: ${days} 天\n\n请审核后点击按钮：`,
          reply_markup: adminMarkup,
          parse_mode: "Markdown"
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
    <div class="desc">${disabledUser ? "您的服务已被暂停，请联系客服处理" : "您的订阅即将到期，请完成续费"}</div>
    <div class="info">
      <p>• 订阅编号: <span>UID-${uid}</span></p>
      <p>• 续费时长: <span>${days} 天</span></p>
      <p>• 费用: <span>${price}</span></p>
    </div>
    <p>${disabledUser ? "🔴 服务暂停中，暂无法在线续费。" : "✅ 续费申请已自动提交给管理员！"}</p>
    <p style="color:#94a3b8; font-size:13px; margin:12px 0;">请前往 Telegram 联系客服完成付款，付款后管理员将立即为您开通。</p>
    <a class="btn btn-secondary" href="${serviceLink}">📩 联系客服</a>
    <a class="btn" href="/s/${uid}">🏠 返回控制台</a>
    <div class="note">AETHERIA Power · 续费工单已生成</div>
  </div>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// ==================== 模块 1.6: 分销落地页 /r/{code} ====================
async function handleResellerLanding(code, request, env) {
  const resellerKeys = await listAllKeys(env, "reseller_", 2000);
  let reseller = null;
  let resellerKey = null;
  for (const k of resellerKeys) {
    const r = JSON.parse(await env.SUB_STORE.get(k));
    if (r.code === code) { reseller = r; resellerKey = k; break; }
  }

  // 记录推广点击（同 IP 10 分钟只记一次）
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
  <title>${reseller ? escapeHtml(reseller.name) : "推广链接"} · ${escapeHtml(DEFAULT_BRAND)} 节点</title>
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
    <h2>${reseller ? escapeHtml(reseller.name) : "推广链接"}</h2>
    <div class="desc">由分销商「${reseller ? escapeHtml(reseller.name) : "未知"}」为您推荐<br>${escapeHtml(DEFAULT_BRAND)} 高速节点服务</div>
    <a class="btn" href="tg://resolve?domain=${getStoreBotUsername()}&start=${code}">🚀 前往购买 (推荐人: ${reseller ? escapeHtml(reseller.name) : "—"})</a>
    <a class="btn" href="${getStoreOrigin(request)}">🌐 查看官网</a>
    <div class="note">AETHERIA Power · 优质节点服务</div>
  </div>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// ==================== 模块 2: 前台售卖 Bot /bot/store ====================
// 发送对应支付方式并创建订单（微信/支付宝发图，USDT 发地址）
async function sendOrderPayInfo(env, chatId, plan, method) {
  const orderId = genOrderId();
  const methodLabel = payMethodLabel(method.id);
  const cancelMarkup = { inline_keyboard: [[{ text: "❌ 取消订单", callback_data: `cancel_order_${orderId}` }]] };

  if (method.id === "usdt") {
    const usdt = await getUsdtInfo(env);
    if (!usdt) {
      await sendMenu(STORE_BOT_TOKEN, chatId, "⚠️ USDT 支付未配置，请联系管理员。", STORE_MENU);
      return null;
    }
    const rate = await getUsdtRate(env);
    const cnyPrice = extractAmount(plan.price);
    const usdtAmount = cnyToUsdt(cnyPrice, rate);
    await sendMenu(STORE_BOT_TOKEN, chatId,
      `🪙 【USDT 支付】\n\n• 订单编号: \`${orderId}\`\n• 套餐: ${plan.name} (${plan.days} 天)\n• 金额: ${plan.price}${usdtAmount ? ` ≈ **${usdtAmount} USDT**（汇率 1 USDT = ¥${rate}）` : ""}\n\n📮 收款地址:\n\`${usdt.address}\`\n\n🌐 网络: ${usdt.network}\n\n📌 请务必使用 ${usdt.network} 网络转账 **${usdtAmount || "对应"} USDT**，金额与套餐一致\n💬 付款后请直接在此发送【转账截图】\n\n⏰ 请在 30 分钟内完成支付`,
      cancelMarkup);
    await env.SUB_STORE.put(`pending_${orderId}`, JSON.stringify({
      chatId, orderId, time: Date.now(), type: "new",
      planId: plan.id, planName: plan.name, planDays: plan.days, planPrice: plan.price,
      paymentMethod: "usdt", usdtAmount, usdtRate: rate
    }), { expirationTtl: 1800 });
    try {
      await sendText(ADMIN_BOT_TOKEN, ADMIN_ID,
        `🛒 【新订单生成】\n• 订单号: ${orderId}\n• 套餐: ${plan.name} (${plan.days}天/${plan.price})\n• 支付方式: 🪙 USDT${usdtAmount ? ` ≈ ${usdtAmount} USDT` : ""}\n• 买家 ChatID: ${chatId}\n\n等待买家付款后提交截图…`);
    } catch (e) {}
    return orderId;
  } else {
    let qrFileId = method.qrFileId;
    let qrList = null;
    if (!qrFileId) {
      if (method.id === "wechat") qrList = await getPayQrs(env, "wechat");
      else if (method.id === "alipay") qrList = await getPayQrs(env, "alipay");
      if (qrList && qrList.length > 0) qrFileId = qrList[Math.floor(Math.random() * qrList.length)].fileId;
    }
    if (!qrFileId) {
      await sendMenu(STORE_BOT_TOKEN, chatId, "⚠️ 该支付方式暂时不可用，请选择其他方式或联系客服。", STORE_MENU);
      return null;
    }
    const photoRes = await fetch(`${TG_API}${STORE_BOT_TOKEN}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        photo: qrFileId,
        caption: `💎 【自助下单结算】\n\n• 订单编号: \`${orderId}\`\n• 支付方式: ${methodLabel}\n• 套餐: ${plan.name} (${plan.days} 天)\n• 金额: ${plan.price}\n\n📌 请使用${methodLabel}扫描下方二维码完成支付\n💬 付款后请直接在此发送【转账截图】\n\n⏰ 请在 30 分钟内完成支付`,
        parse_mode: "Markdown",
        reply_markup: cancelMarkup
      })
    });
    const photoJson = await photoRes.json().catch(() => ({}));
    if (!photoJson.ok) {
      if (qrList && qrList.length > 1) {
        const newList = qrList.filter(q => q.fileId !== qrFileId);
        await savePayQrs(env, method.id, newList);
        try { await sendText(ADMIN_BOT_TOKEN, ADMIN_ID, `⚠️ ${methodLabel}收款码已失效，已自动移除一张。`); } catch (e) {}
      }
      await sendMenu(STORE_BOT_TOKEN, chatId, "⚠️ 收款码暂时不可用，请稍后重试或联系客服。", STORE_MENU);
      return null;
    }
  }

  await env.SUB_STORE.put(`pending_${orderId}`, JSON.stringify({
    chatId, orderId, time: Date.now(), type: "new",
    planId: plan.id, planName: plan.name, planDays: plan.days, planPrice: plan.price,
    paymentMethod: method.id
  }), { expirationTtl: 1800 });

  try {
    await sendText(ADMIN_BOT_TOKEN, ADMIN_ID,
      `🛒 【新订单生成】\n• 订单号: ${orderId}\n• 套餐: ${plan.name} (${plan.days}天/${plan.price})\n• 支付方式: ${methodLabel}\n• 买家 ChatID: ${chatId}\n\n等待买家付款后提交截图…`);
  } catch (e) {}
  return orderId;
}

async function handleStoreBot(request, env) {
  try {
    const update = await request.json();

    // ===== 回调处理 =====
    if (update.callback_query) {
      const cb = update.callback_query;
      const cbChat = cb.message && cb.message.chat;
      if (!cbChat || (cbChat.type && cbChat.type !== "private")) return new Response("OK");
      const cbChatId = cbChat.id;
      const cbData = cb.data;

      if (cbData === "cancel_buy") {
        await answerCb(STORE_BOT_TOKEN, cb.id, "❌ 已取消");
        try { await delMsg(STORE_BOT_TOKEN, cbChatId, cb.message.message_id); } catch (e) {}
        return new Response("OK");
      }

      // 取消订单（买家取消未付款订单）
      if (cbData.startsWith("cancel_order_")) {
        const oid = cbData.replace("cancel_order_", "");
        await env.SUB_STORE.delete(`pending_${oid}`);
        try { await delMsg(STORE_BOT_TOKEN, cbChatId, cb.message.message_id); } catch (e) {}
        try {
          await sendText(ADMIN_BOT_TOKEN, ADMIN_ID, `🚫 【订单已取消】\n订单号: ${oid}\n买家 ChatID: ${cbChatId}\n\n该订单未付款，已被买家取消。`);
        } catch (e) {}
        await answerCb(STORE_BOT_TOKEN, cb.id, "✅ 订单已取消，可重新下单");
        return new Response("OK");
      }

      // 选择套餐 → 选择支付方式 → 展示付款信息
      if (cbData.startsWith("buyplan_")) {
        const planId = cbData.replace("buyplan_", "");
        const plan = (await getPlans(env)).find(p => p.id === planId);

        // 防抖：5 分钟内有未完成订单则拦截
        try {
          const pendingKeys = await listAllKeys(env, "pending_", 2000);
          const now = Date.now();
          for (const k of pendingKeys) {
            const o = JSON.parse(await env.SUB_STORE.get(k));
            if (o.chatId === cbChatId && (now - (o.time || 0)) < 5 * 60 * 1000) {
              await answerCb(STORE_BOT_TOKEN, cb.id, "⏳ 您有一笔订单处理中，请先完成支付或等待处理");
              return new Response("OK");
            }
          }
        } catch (e) {}

        await answerCb(STORE_BOT_TOKEN, cb.id, plan ? `已选 ${plan.name}` : "套餐不存在");

        if (!plan || plan.enabled === false) {
          try { await delMsg(STORE_BOT_TOKEN, cbChatId, cb.message.message_id); } catch (e) {}
          return new Response("OK");
        }
        if (!(await rateLimit(env, "order", cbChatId, 5))) {
          await answerCb(STORE_BOT_TOKEN, cb.id, "⏳ 操作太快啦，请稍后再试");
          return new Response("OK");
        }

        const methods = await getAvailablePayMethods(env);
        if (methods.length === 0) {
          await sendMenu(STORE_BOT_TOKEN, cbChatId, "⚠️ 系统暂未配置支付方式，请联系管理员。", STORE_MENU);
          return new Response("OK");
        }

        if (methods.length === 1) {
          await sendOrderPayInfo(env, cbChatId, plan, methods[0]);
          return new Response("OK");
        }

        // 多种支付方式 → 弹选择
        await sendMenu(STORE_BOT_TOKEN, cbChatId,
          `💳 【选择支付方式】\n套餐: ${plan.name} (${plan.days}天 / ${plan.price})\n\n请选择支付方式：`,
          { inline_keyboard: [methods.map(m => ({ text: m.label, callback_data: `paymethod_${m.id}_${planId}` })), [{ text: "❌ 取消", callback_data: "cancel_buy" }]] });
        return new Response("OK");
      }

      // 选择支付方式 → 生成订单并发对应付款信息
      if (cbData.startsWith("paymethod_")) {
        const parts = cbData.replace("paymethod_", "").split("_");
        const payMethod = parts[0];
        const planId = parts.slice(1).join("_");
        const plan = (await getPlans(env)).find(p => p.id === planId);
        if (!plan || plan.enabled === false) {
          await answerCb(STORE_BOT_TOKEN, cb.id, "❌ 套餐不可用");
          return new Response("OK");
        }
        if (!(await rateLimit(env, "order", cbChatId, 5))) {
          await answerCb(STORE_BOT_TOKEN, cb.id, "⏳ 操作太快啦，请稍后再试");
          return new Response("OK");
        }
        await sendOrderPayInfo(env, cbChatId, plan, { id: payMethod, type: payMethod === "usdt" ? "text" : "qr" });
        return new Response("OK");
      }
      return new Response("OK");
    }

    const msg = update.message;
    if (!msg) return new Response("OK");
    if (msg.chat && msg.chat.type && msg.chat.type !== "private") return new Response("OK");

    const chatId = msg.chat.id;
    let text = msg.text || msg.caption || "";

    // 左侧命令菜单 → 菜单按钮映射
    const cmdMap = {
      "/query": "🔍 查询订阅", "/card": "🎫 兑换卡密", "/coupon": "🎁 优惠券",
      "/faq": "❓ 常见问题", "/service": "📞 联系客服", "/buy": "🛒 购买套餐"
    };
    if (cmdMap[text]) text = cmdMap[text];

    // 购买套餐（含分销深链解析）
    if (text === "🛒 购买套餐" || text === "/buy" || text.startsWith("/start") || text.includes("购买")) {
      if (text.startsWith("/start")) {
        const startPayload = ((msg.text || "").split(/\s+/)[1] || "").trim();
        if (startPayload) {
          const resellers = await listAllKeys(env, "reseller_", 2000);
          for (const k of resellers) {
            try {
              const r = JSON.parse(await env.SUB_STORE.get(k));
              if (r.code === startPayload.toUpperCase()) {
                await setBuyerAffiliate(env, chatId, r.code);
                await sendText(STORE_BOT_TOKEN, chatId,
                  `🎁 【推荐人已关联】\n您由分销商「${r.name}」推荐！\n购买后分销商将获得相应佣金。`);
                break;
              }
            } catch (e) {}
          }
        }
      }

      const plans = await getActivePlans(env);
      if (plans.length === 0) {
        await sendMenu(STORE_BOT_TOKEN, chatId, "⚠️ 当前暂无在售套餐，请稍后再来或联系客服。", STORE_MENU);
        return new Response("OK");
      }
      if ((await getAvailablePayMethods(env)).length === 0) {
        await sendMenu(STORE_BOT_TOKEN, chatId, "⚠️ 系统暂未配置支付方式，请联系管理员。", STORE_MENU);
        return new Response("OK");
      }

      const notice = await env.SUB_STORE.get("notice_content");
      if (notice && text.startsWith("/start")) {
        await sendText(STORE_BOT_TOKEN, chatId, `📢 【公告】\n${notice}`);
      }

      const planBtns = plans.map(p => [{ text: `📦 ${p.name} (${p.days}天 / ${p.price})`, callback_data: `buyplan_${p.id}` }]);
      planBtns.push([{ text: "❌ 取消", callback_data: "cancel_buy" }]);
      await tg(STORE_BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        text: `🛒 【选择套餐】\n\n请选择您需要的套餐：`,
        reply_markup: { inline_keyboard: planBtns }
      });
      return new Response("OK");
    }

    // 查询订阅
    if (text === "🔍 查询订阅") {
      const uid = await findUidByChatId(env, chatId);
      if (uid) {
        const u = JSON.parse(await env.SUB_STORE.get(`user_${uid}`));
        const remainDays = Math.ceil((u.expiry - Date.now()) / 86400000);
        const stateDesc = u.status === "disabled" ? "🔴 禁用中" : (remainDays <= 0 ? "⏳ 已过期" : "🟢 正常运行");
        await sendMenu(STORE_BOT_TOKEN, chatId,
          `📊 【您的订阅信息】\n\n• 订阅编号: \`${uid}\`\n• 套餐: ${u.plan || "标准套餐"}\n• 状态: ${stateDesc}\n• 剩余: ${Math.max(0, remainDays)} 天\n• 到期: ${new Date(u.expiry).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })}\n\n🔗 管理面板:\n${getStoreOrigin(request)}/s/${uid}`,
          STORE_MENU);
      } else {
        await sendMenu(STORE_BOT_TOKEN, chatId, "❌ 您目前还没有订阅。\n点击下方【🛒 购买套餐】开始！", STORE_MENU);
      }
      return new Response("OK");
    }

    // 常见问题
    if (text === "❓ 常见问题") {
      const price = (await env.SUB_STORE.get("price_info")) || "联系客服获取";
      const days = (await env.SUB_STORE.get("default_days")) || DEFAULT_DAYS;
      await sendMenu(STORE_BOT_TOKEN, chatId,
        `❓ 【常见问题】\n\n` +
        `**1. 如何购买？**\n点【🛒 购买套餐】→ 选套餐 → 扫码付款 → 发截图 → 自动开通\n\n` +
        `**2. 如何兑换卡密？**\n点【🎫 兑换卡密】→ 输入卡密 → 秒开通\n\n` +
        `**3. 如何查看我的订阅？**\n点【🔍 查询订阅】即可看到到期时间和状态\n\n` +
        `**4. 怎么导入客户端？**\n打开订阅链接 → 网页控制台 → 一键导入 Clash 或复制订阅地址\n\n` +
        `**5. 套餐价格？**\n${price}\n\n` +
        `**6. 忘记续费过期了？**\n网页控制台点【🔄 立即续费】或联系客服\n\n` +
        `**7. 还有其他问题？**\n点【📞 联系客服】`,
        STORE_MENU);
      return new Response("OK");
    }

    // 智能 FAQ 关键词匹配
    if (text && !msg.photo && text.length < 50) {
      const lower = text.toLowerCase();
      const faqMatch = (lower.includes("怎么") || lower.includes("如何") || lower.includes("购买") || lower.includes("价格") || lower.includes("多少钱") || lower.includes("卡密") || lower.includes("兑换") || lower.includes("过期") || lower.includes("续费") || lower.includes("节点") || lower.includes("clash") || lower.includes("订阅"))
        && !["🛒 购买套餐", "🔍 查询订阅", "🎫 兑换卡密", "❓ 常见问题", "📞 联系客服"].includes(text);
      if (faqMatch) {
        const price = (await env.SUB_STORE.get("price_info")) || "联系客服获取";
        await sendMenu(STORE_BOT_TOKEN, chatId,
          `💡 【自助解答】\n\n` +
          `• 购买: 点【🛒 购买套餐】选套餐付款即可\n` +
          `• 兑换: 点【🎫 兑换卡密】输入卡密秒开通\n` +
          `• 价格: ${price}\n` +
          `• 导入: 打开订阅链接一键导入 Clash\n\n` +
          `如果以上没有解决您的问题，请点【📞 联系客服】`,
          STORE_MENU);
        return new Response("OK");
      }
    }

    // 联系客服
    if (text === "📞 联系客服") {
      const serviceContact = await env.SUB_STORE.get("service_contact") || "";
      if (serviceContact) {
        await tg(STORE_BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          text: `📞 【联系客服】\n\n点击下方按钮即可联系客服：`,
          reply_markup: {
            inline_keyboard: [
              [{ text: "💬 联系客服", url: buildServiceLink(serviceContact) }]
            ]
          }
        });
      } else {
        await sendMenu(STORE_BOT_TOKEN, chatId,
          `📞 【联系客服】\n\n如需帮助，请直接在此发送消息或截图，\n管理员会尽快回复您！`,
          STORE_MENU);
      }
      return new Response("OK");
    }

    // 兑换卡密 / 优惠券 引导
    if (text === "🎫 兑换卡密") {
      await env.SUB_STORE.put(`redeem_state_${chatId}`, JSON.stringify({ time: Date.now() }), { expirationTtl: 600 });
      await sendMenu(STORE_BOT_TOKEN, chatId,
        `🎫 【卡密兑换】\n\n请发送您的卡密（格式：MB-XXXX-XXXX-XXXX）\n\n兑换后自动开通对应时长的订阅！`,
        STORE_MENU);
      return new Response("OK");
    }
    if (text === "🎁 优惠券") {
      await env.SUB_STORE.put(`coupon_state_${chatId}`, JSON.stringify({ time: Date.now() }), { expirationTtl: 600 });
      await sendMenu(STORE_BOT_TOKEN, chatId,
        `🎁 【优惠券兑换】\n\n请发送您的优惠券码（格式：CP-XXXX-XXXX-XXXX）\n\n兑换后自动开通对应时长的订阅！`,
        STORE_MENU);
      return new Response("OK");
    }

    // 优惠券输入（处于兑换状态或直接发 CP- 前缀；卡密 MB- 前缀不被劫持）
    const couponStateStr = await env.SUB_STORE.get(`coupon_state_${chatId}`);
    if ((couponStateStr || /^CP-/.test(text.toUpperCase())) && !/^MB-/.test(text.toUpperCase()) && text.trim()) {
      const cCode = text.trim().toUpperCase();
      const cResult = await redeemCoupon(env, cCode, chatId);
      await env.SUB_STORE.delete(`coupon_state_${chatId}`);
      if (cResult.ok) {
        const origin = getStoreOrigin(request);
        await sendMenu(STORE_BOT_TOKEN, chatId,
          `${cResult.msg}！\n\n• 套餐: ${cResult.plan}\n• 时长: ${cResult.days} 天\n\n🔗 专属短链:\n\`${origin}/s/${cResult.uid}\``,
          STORE_MENU);
        await sendText(ADMIN_BOT_TOKEN, ADMIN_ID, `🎁 优惠券兑换成功\n券码: ${cCode}\n买家 ChatID: ${chatId}\nUID: ${cResult.uid}`);
      } else {
        await sendMenu(STORE_BOT_TOKEN, chatId, cResult.msg, STORE_MENU);
      }
      return new Response("OK");
    }

    // 卡密输入（处于兑换状态或直接发 MB- 前缀）
    const redeemStateStr = await env.SUB_STORE.get(`redeem_state_${chatId}`);
    if ((redeemStateStr || /^MB-/.test(text.toUpperCase())) && text.trim()) {
      const code = text.trim().toUpperCase();
      const result = await redeemCard(env, code, chatId);
      await env.SUB_STORE.delete(`redeem_state_${chatId}`);
      if (result.ok) {
        const origin = getStoreOrigin(request);
        await sendMenu(STORE_BOT_TOKEN, chatId,
          `${result.msg}！\n\n• 套餐: ${result.plan}\n• 时长: ${result.days} 天\n\n🔗 专属短链:\n\`${origin}/s/${result.uid}\``,
          STORE_MENU);
        await sendText(ADMIN_BOT_TOKEN, ADMIN_ID, `🎫 卡密兑换成功\n卡密: ${code}\n买家 ChatID: ${chatId}\nUID: ${result.uid}`);
      } else {
        await sendMenu(STORE_BOT_TOKEN, chatId, result.msg, STORE_MENU);
      }
      return new Response("OK");
    }

    // 非媒体消息处理
    const hasMedia = !!(msg.photo || msg.video || msg.document);
    if (!hasMedia) {
      const redeeming = await env.SUB_STORE.get(`redeem_state_${chatId}`);
      if (redeeming || /^MB-/.test(text.toUpperCase())) {
        await sendMenu(STORE_BOT_TOKEN, chatId, "🎫 请输入有效的卡密（格式：MB-XXXX-XXXX-XXXX）", STORE_MENU);
        return new Response("OK");
      }
      const payKeywords = ["付了", "付款", "支付", "转账", "截图", "已付", "扫码付", "发了"];
      if (payKeywords.some(k => text.includes(k))) {
        await sendMenu(STORE_BOT_TOKEN, chatId,
          `📌 【提交付款凭证】\n\n请直接发送您的【转账截图/付款凭证图片】！\n\n系统会自动提交给管理员审核，审核通过后立即开通订阅。\n\n（如果已经发过截图，请耐心等待审核）`,
          STORE_MENU);
        return new Response("OK");
      }
      if (text.startsWith("/")) {
        await sendMenu(STORE_BOT_TOKEN, chatId,
          "❓ 未识别的命令，请使用下方菜单操作：\n🛒 购买套餐 / 🔍 查询订阅 / 🎫 兑换卡密 / 📞 联系客服",
          STORE_MENU);
        return new Response("OK");
      }
      await sendMenu(STORE_BOT_TOKEN, chatId,
        `💬 收到您的消息！\n\n如需帮助请使用下方菜单：\n🛒 购买套餐 / 🔍 查询订阅 / 🎫 兑换卡密 / 📞 联系客服\n\n📌 温馨提示：付款成功后，请直接发送【转账截图/付款凭证图片】，系统会自动提交审核。`,
        STORE_MENU);
      return new Response("OK");
    }

    // ===== 付款凭证审核流程（带媒体）=====
    if (!(await rateLimit(env, "proof", chatId, 30))) {
      await sendMenu(STORE_BOT_TOKEN, chatId, "⏳ 操作太频繁，请稍等 30 秒再发送截图", STORE_MENU);
      return new Response("OK");
    }

    const buyerName = msg.from.first_name || "用户";
    const buyerUsername = msg.from.username ? `@${msg.from.username}` : "无";

    // 匹配该买家最近待审订单
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

    // 买家提交凭证后刷新订单 TTL，避免管理员稍后处理时订单已过期
    if (orderInfo) {
      try {
        await env.SUB_STORE.put(`pending_${orderInfo.orderId}`, JSON.stringify(orderInfo), { expirationTtl: 86400 });
      } catch (e) {}
    }

    const forwardJson = await tg(STORE_BOT_TOKEN, "forwardMessage", {
      chat_id: ADMIN_ID, from_chat_id: chatId, message_id: msg.message_id
    });
    const forwardOk = forwardJson.ok === true;

    if (!forwardOk && msg.photo) {
      try {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        await tg(STORE_BOT_TOKEN, "sendPhoto", {
          chat_id: ADMIN_ID, photo: fileId,
          caption: `📸 付款凭证副本\n• 买家: ${buyerName} (${buyerUsername})\n• ChatID: ${chatId}`
        });
      } catch (e) {}
    }

    const replyMarkup = {
      inline_keyboard: [
        orderInfo
          ? [
            { text: "🟢 确认到账 · 一键开通", callback_data: `approve_${chatId}_${orderInfo.orderId}` },
            { text: "⏳ 稍后处理", callback_data: "later" },
            { text: "❌ 拒绝", callback_data: `reject_proof_${orderInfo.orderId}_${chatId}` }
          ]
          : [
            { text: "⚠️ 无匹配订单，需人工核实", callback_data: "later" }
          ]
      ]
    };

    const orderLine = orderInfo
      ? `• 订单号: ${orderInfo.orderId || "—"}\n• 套餐: ${orderInfo.planName || "默认"} (${orderInfo.planDays || "?"}天 / ${orderInfo.planPrice || "?"})\n${orderInfo.paymentMethod && orderInfo.paymentMethod !== "default" ? `• 支付方式: ${payMethodLabel(orderInfo.paymentMethod)}${orderInfo.paymentMethod === "usdt" && orderInfo.usdtAmount ? ` ≈ ${orderInfo.usdtAmount} USDT` : ""}\n` : ""}`
      : "";
    await tg(ADMIN_BOT_TOKEN, "sendMessage", {
      chat_id: ADMIN_ID,
      text: `📦 【收到新付款凭证】\n• 买家: ${buyerName}\n• 用户名: ${buyerUsername}\n• ChatID: ${chatId}\n${orderLine}\n${forwardOk ? "📎 凭证截图已转发到前台 Bot 会话" : "⚠️ 截图转发失败，请查看前台 Bot 会话"}\n\n请审核后点击下方按钮：`,
      reply_markup: replyMarkup
    });

    await sendMenu(STORE_BOT_TOKEN, chatId, "📩 凭证已成功提交给管理员，请稍候！", STORE_MENU);
    return new Response("OK");
  } catch (err) {
    return new Response("OK");
  }
}

// ==================== 模块 3: 后台管理 Bot /bot/admin ====================
async function handleAdminBot(request, env) {
  try {
    const update = await request.json();

    // ===== 回调处理 =====
    if (update.callback_query) {
      const cb = update.callback_query;
      if (cb.from.id !== ADMIN_ID) return new Response("OK");

      const chatId = cb.message.chat.id;
      const data = cb.data;
      let replyAlert = "";
      let replyText = "";
      let replyMarkup = null;

      // 续费确认 / 拒绝
      if (data.startsWith("approve_renew_")) {
        const rparts = data.replace("approve_renew_", "").split("_");
        const rUid = rparts[0];
        const rChatId = rparts.slice(1).join("_");
        const renewProcessedKey = `processed_renew_${rUid}`;
        if (await env.SUB_STORE.get(renewProcessedKey)) {
          replyAlert = "⚠️ 该续费请求已被处理过了，请勿重复操作！";
        } else {
        const rUserStr = await env.SUB_STORE.get(`user_${rUid}`);
        if (!rUserStr) {
          replyText = `❌ 用户 UID:${rUid} 不存在`;
        } else {
          const ru = JSON.parse(rUserStr);
          const days = parseInt(await env.SUB_STORE.get("default_days")) || DEFAULT_DAYS;
          const prevExpiry = ru.expiry;
          await env.SUB_STORE.put(renewProcessedKey, JSON.stringify({ chatId: rChatId, time: Date.now() }), { expirationTtl: 86400 });
          ru.expiry = Math.max(ru.expiry, Date.now()) + (days * 86400000);
          ru.status = "active";
          delete ru.lastNotified;
          await env.SUB_STORE.put(`user_${rUid}`, JSON.stringify(ru));

          const rOrderId = "RENEW-" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
          await env.SUB_STORE.put(`record_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, JSON.stringify({
            orderId: rOrderId, chatId: ru.chatId || rChatId, plan: `${days} 天续费`, days,
            price: await env.SUB_STORE.get("price_info") || "", time: Date.now(), uid: rUid, type: "renew"
          }), { expirationTtl: 15552000 });

          await env.SUB_STORE.put(`revoke_${cb.message.message_id}`, JSON.stringify({
            uid: rUid, chatId: ru.chatId || rChatId, prevExpiry, isNew: false, days, orderId: rOrderId, time: Date.now()
          }), { expirationTtl: 86400 });

          await logAction(env, "确认续费", `UID:${rUid} +${days}天 (续费请求)`);
          try {
            const origin = new URL(request.url).origin;
            await sendText(STORE_BOT_TOKEN, ru.chatId || rChatId,
              `🎉 【续费成功】\n您的续费请求已通过！\n\n• 时长: ${days} 天\n• 到期: ${new Date(ru.expiry).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })}\n\n🔗 ${origin}/s/${rUid}`);
          } catch (e) {}
          replyAlert = `✅ 续费已确认！UID:${rUid} (+${days}天)`;
          try {
            await editMsg(ADMIN_BOT_TOKEN, cb.message.chat.id, cb.message.message_id,
              `✅ 【续费已处理】\nUID: ${rUid}\n时长: +${days} 天\n\n如需撤销请点击下方按钮。`,
              { inline_keyboard: [[{ text: "↩️ 撤销此操作", callback_data: `revoke_${cb.message.message_id}` }]] });
          } catch (e) {}
        }
        }
      }
      else if (data.startsWith("reject_renew_")) {
        const rparts = data.replace("reject_renew_", "").split("_");
        const rUid = rparts[0];
        const rChatId = rparts.slice(1).join("_");
        const rUserStr = await env.SUB_STORE.get(`user_${rUid}`);
        if (!rUserStr) {
          replyText = `❌ 用户 UID:${rUid} 不存在`;
        } else {
          const ru = JSON.parse(rUserStr);
          try {
            await sendText(STORE_BOT_TOKEN, ru.chatId || rChatId,
              `❌ 【续费被拒绝】\n很抱歉，您的续费请求被管理员拒绝了。\n\n如有疑问请联系客服。`);
          } catch (e) {}
          await logAction(env, "拒绝续费", `UID:${rUid} ChatID:${ru.chatId || rChatId}`);
          replyAlert = `❌ 已拒绝用户 [${rUid}] 的续费请求，已通知买家。`;
          try {
            await editMsg(ADMIN_BOT_TOKEN, cb.message.chat.id, cb.message.message_id,
              `❌ 【续费已拒绝】\nUID: ${rUid} 的续费请求已被拒绝。\n\n已通知买家。`, null);
          } catch (e) {}
        }
      }

      // 确认到账 → 开通（区分新购/续费，幂等保护）
      else if (data.startsWith("approve_")) {
        const parts = data.split("_");
        const targetChatId = parts[1];
        const approveOrderId = parts.slice(2).join("_") || null;
        const targetChatIdNum = parseInt(targetChatId);
        const defaultUpstream = await getDefaultUpstream(env);

        let orderPlan = null;
        try {
          const orderKeys = await listAllKeys(env, "pending_", 1000);
          let newestTime = 0;
          for (const k of orderKeys) {
            const o = JSON.parse(await env.SUB_STORE.get(k));
            if (o.chatId === targetChatIdNum) {
              if (approveOrderId && approveOrderId !== "0" && o.orderId === approveOrderId) { orderPlan = o; break; }
              if (!approveOrderId || approveOrderId === "0") {
                if ((o.time || 0) > newestTime) { orderPlan = o; newestTime = o.time || 0; }
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

        const processedKey = `processed_${targetChatId}_${approveOrderId || "0"}`;
        if (await env.SUB_STORE.get(processedKey)) {
          replyAlert = "⚠️ 该凭证已被处理过了，请勿重复操作！";
        } else if (approveOrderId && approveOrderId !== "0" && !orderPlan) {
          replyAlert = "❌ 该订单不存在或已过期，请让买家重新下单";
        } else if (!defaultUpstream) {
          replyAlert = "❌ 错误：请先在管理端配置默认上游链接！";
        } else {
          await env.SUB_STORE.put(processedKey, JSON.stringify({ chatId: targetChatId, time: Date.now() }), { expirationTtl: 86400 });
          const existingUid = await findUidByChatId(env, targetChatIdNum);

          let finalUid;
          let prevExpiry = null;
          if (existingUid) {
            const existing = JSON.parse(await env.SUB_STORE.get(`user_${existingUid}`));
            prevExpiry = existing.expiry;
            existing.expiry = Math.max(existing.expiry, Date.now()) + (days * 86400000);
            existing.status = "active";
            delete existing.lastNotified;
            if (orderPlan) existing.plan = planLabel;
            await env.SUB_STORE.put(`user_${existingUid}`, JSON.stringify(existing));
            finalUid = existingUid;
          } else {
            finalUid = await genUniqueUid(env);
            await env.SUB_STORE.put(`user_${finalUid}`, JSON.stringify({
              upstreamUrl: defaultUpstream, expiry: Date.now() + (days * 86400000), status: "active",
              brand: DEFAULT_BRAND, chatId: targetChatIdNum, createdAt: Date.now(), plan: planLabel
            }));
            await indexUserChatId(env, targetChatIdNum, finalUid);
          }

          if (orderPlan) {
            await env.SUB_STORE.put(`record_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, JSON.stringify({
              orderId: orderPlan.orderId || genOrderId(), chatId: targetChatIdNum, plan: planLabel, days,
              price: orderPlan.planPrice || "", time: Date.now(), uid: finalUid, type: existingUid ? "renew" : "new"
            }), { expirationTtl: 15552000 });
            try { await env.SUB_STORE.delete(`pending_${orderPlan.orderId}`); } catch (e) {}
            await creditReseller(env, targetChatIdNum, orderPlan.planPrice);
          }

          await env.SUB_STORE.put(`revoke_${cb.message.message_id}`, JSON.stringify({
            uid: finalUid, chatId: targetChatIdNum, prevExpiry, isNew: !existingUid,
            days, orderId: orderPlan ? orderPlan.orderId : null, time: Date.now()
          }), { expirationTtl: 86400 });

          await logAction(env, existingUid ? "确认续费" : "确认发货", `UID:${finalUid} ChatID:${targetChatId} ${planLabel} ${days}天`);

          const subLink = `${new URL(request.url).origin}/s/${finalUid}`;
          await sendText(STORE_BOT_TOKEN, targetChatId,
            existingUid
              ? `🎉 【续费成功】\n您的订阅已成功续费！\n\n• 套餐: ${planLabel}\n• 时长: ${days} 天\n\n🔗 专属短链:\n\`${subLink}\`\n\n服务有效期已延长，感谢支持！`
              : `🎉 【订单审核通过】\n您的专属订阅已开通完成！\n\n• 套餐: ${planLabel}\n• 时长: ${days} 天\n\n🔗 专属短链:\n\`${subLink}\`\n\n📌 点击链接可打开网页控制台，也可直接导入客户端。`);

          replyAlert = existingUid
            ? `✅ 续费成功！UID: ${finalUid} (+${days}天)`
            : `✅ 已成功发货！分配 UID: ${finalUid} (${days}天)`;

          try {
            await editMsg(ADMIN_BOT_TOKEN, cb.message.chat.id, cb.message.message_id,
              `✅ 【已处理】该凭证已确认到账，订阅已开通。\n\nUID: ${finalUid}\n买家 ChatID: ${targetChatId}\n套餐: ${planLabel}\n时长: ${days} 天\n\n如需撤销请点击下方按钮。`,
              {
                inline_keyboard: [
                  [
                    { text: "🟢 确认到账 · 一键开通", callback_data: `approve_${targetChatId}_${approveOrderId || "0"}` },
                    { text: "⏳ 稍后处理", callback_data: "later" }
                  ],
                  [{ text: "↩️ 撤销此操作", callback_data: `revoke_${cb.message.message_id}` }]
                ]
              });
          } catch (e) {}
        }
      }
      else if (data === "later") {
        const origButtons = (cb.message && cb.message.reply_markup && cb.message.reply_markup.inline_keyboard) || [];
        replyAlert = "⏳ 已标记稍后处理";
        try {
          await editMsg(ADMIN_BOT_TOKEN, cb.message.chat.id, cb.message.message_id,
            `⏳ 【已标记稍后处理】\n此凭证暂不处理，稍后可回来点击按钮继续。`,
            { inline_keyboard: origButtons });
        } catch (e) {}
      }

      // 拒绝付款凭证
      else if (data.startsWith("reject_proof_")) {
        const rparts = data.replace("reject_proof_", "").split("_");
        const rOid = rparts[0];
        const rBuyer = parseInt(rparts.slice(1).join("_"));
        await env.SUB_STORE.delete(`pending_${rOid}`);
        await logAction(env, "拒绝凭证", `订单:${rOid} 买家:${rBuyer}`);
        if (!isNaN(rBuyer)) {
          try {
            await sendText(STORE_BOT_TOKEN, rBuyer,
              `❌ 【付款凭证未通过审核】\n您的截图不清晰或金额不符，请重新发送清晰的转账截图。\n\n如有疑问请联系客服。`);
          } catch (e) {}
        }
        replyAlert = `❌ 已拒绝买家 [${rBuyer}] 的凭证，已通知重新提交`;
        try {
          await editMsg(ADMIN_BOT_TOKEN, cb.message.chat.id, cb.message.message_id,
            `❌ 【凭证已拒绝】\n订单: ${rOid}\n已通知买家重新提交。`,
            null);
        } catch (e) {}
      }

      // 撤销删除用户
      else if (data.startsWith("revoke_del_")) {
        const dId = data.replace("revoke_del_", "");
        const dStr = await env.SUB_STORE.get(`revoke_del_${dId}`);
        if (!dStr) {
          replyText = "❌ 撤销记录不存在或已过期（24小时）";
        } else {
          const d = JSON.parse(dStr);
          await env.SUB_STORE.put(`user_${d.uid}`, JSON.stringify(d.data));
          await indexUserChatId(env, d.data.chatId, d.uid);
          await env.SUB_STORE.delete(`revoke_del_${dId}`);
          replyText = `↩️ 已恢复！用户 UID:${d.uid} 已还原`;
        }
      }

      // 撤销手动开卡
      else if (data.startsWith("revoke_manual_")) {
        const mId = data.replace("revoke_manual_", "");
        const mStr = await env.SUB_STORE.get(`revoke_manual_${mId}`);
        if (!mStr) {
          replyText = "❌ 撤销记录不存在或已过期（24小时）";
        } else {
          const m = JSON.parse(mStr);
          const userDataStr = await env.SUB_STORE.get(`user_${m.uid}`);
          if (!userDataStr) {
            replyText = `❌ 用户 UID:${m.uid} 不存在或已删除`;
          } else {
            const mUser = JSON.parse(userDataStr);
            await env.SUB_STORE.delete(`user_${m.uid}`);
            await clearUserCache(env, m.uid);
            await unindexUserChatId(env, mUser.chatId);
            try { await sendText(STORE_BOT_TOKEN, m.chatId, `⚠️ 【开通已撤销】\n管理员撤销了刚才的开通操作。\n如您已付款请联系客服核实。`); } catch (e) {}
            await env.SUB_STORE.delete(`revoke_manual_${mId}`);
            replyText = `↩️ 已撤销！用户 UID:${m.uid} 已删除`;
          }
        }
      }

      // 撤销调整时长
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
            await env.SUB_STORE.delete(`revoke_adjust_${adjId}`);
            replyText = `↩️ 已撤销！UID:${adj.uid} 已恢复原到期时间`;
          }
        }
      }

      // 撤销确认到账
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
              await env.SUB_STORE.delete(`user_${rev.uid}`);
              await clearUserCache(env, rev.uid);
              await unindexUserChatId(env, rev.chatId);
              await sendText(STORE_BOT_TOKEN, rev.chatId, `⚠️ 【开通已撤销】\n管理员撤销了刚才的开通操作。\n如您已付款请联系客服核实。`);
              replyText = `↩️ 已撤销！新用户 UID:${rev.uid} 已删除`;
            } else {
              const u = JSON.parse(userDataStr);
              u.expiry = rev.prevExpiry;
              await env.SUB_STORE.put(`user_${rev.uid}`, JSON.stringify(u));
              await sendText(STORE_BOT_TOKEN, rev.chatId, `⚠️ 【续费已撤销】\n管理员撤销了刚才的续费操作，订阅时长已恢复。\n如您已付款请联系客服核实。`);
              replyText = `↩️ 已撤销！UID:${rev.uid} 已恢复原到期时间`;
            }
            if (rev.orderId) {
              try {
                for (const rk of await listAllKeys(env, "record_", 2000)) {
                  try {
                    const r = JSON.parse(await env.SUB_STORE.get(rk));
                    if (r.orderId === rev.orderId) { await env.SUB_STORE.delete(rk); break; }
                  } catch (e) {}
                }
              } catch (e) {}
            }
            await env.SUB_STORE.delete(`revoke_${msgId}`);
          }
        }
      }

      // 恢复删除的用户
      else if (data.startsWith("undel_")) {
        const uid = data.replace("undel_", "");
        let found = false;
        for (const k of await listAllKeys(env, "revoke_del_", 2000)) {
          const d = JSON.parse(await env.SUB_STORE.get(k));
          if (d.uid === uid) {
            await env.SUB_STORE.put(`user_${uid}`, JSON.stringify(d.data));
            await indexUserChatId(env, d.data.chatId, uid);
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

      // 卡密列表：翻页
      else if (data.startsWith("card_list_page_")) {
        const pg = parseInt(data.replace("card_list_page_", "")) || 1;
        await sendCardList(env, chatId, pg, cb.message.message_id);
        replyText = "";
      }

      // 卡密列表：查看单张详情
      else if (data.startsWith("card_lookup_")) {
        const code = data.replace("card_lookup_", "");
        const str = await env.SUB_STORE.get(`card_${code}`);
        if (!str) {
          replyAlert = "❌ 卡密不存在";
        } else {
          const c = JSON.parse(str);
          const statusDesc = c.status === "used" ? `已使用 🔵\n使用人: ${c.usedBy}\n使用时间: ${new Date(c.usedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}` : (c.status === "disabled" ? "已禁用 🔴" : "未使用 🟢");
          replyText = `🎫 【卡密信息】\n\n• 卡密: \`${c.code}\`\n• 套餐: ${c.planName}\n• 时长: ${c.days} 天\n• 价格: ${c.price || "未设置"}\n• 状态: ${statusDesc}`;
        }
      }

      // 卡密禁用/启用/删除（须在用户 disable_/enable_/del_ 之前，避免前缀截胡）
      else if (data.startsWith("disable_card_")) {
        const code = data.replace("disable_card_", "");
        const str = await env.SUB_STORE.get(`card_${code}`);
        if (!str) {
          replyAlert = "❌ 卡密不存在";
        } else {
          const c = JSON.parse(str);
          if (c.status === "used") {
            replyAlert = "❌ 该卡密已被使用，无法禁用";
          } else {
            c.status = "disabled";
            await env.SUB_STORE.put(`card_${code}`, JSON.stringify(c));
            await logAction(env, "禁用卡密", code);
            replyAlert = `🔴 卡密 ${code} 已禁用，不可再兑换`;
          }
        }
      }
      else if (data.startsWith("enable_card_")) {
        const code = data.replace("enable_card_", "");
        const str = await env.SUB_STORE.get(`card_${code}`);
        if (!str) {
          replyAlert = "❌ 卡密不存在";
        } else {
          const c = JSON.parse(str);
          if (c.status === "used") {
            replyAlert = "❌ 该卡密已被使用，无法启用";
          } else {
            c.status = "unused";
            await env.SUB_STORE.put(`card_${code}`, JSON.stringify(c));
            await logAction(env, "启用卡密", code);
            replyAlert = `🟢 卡密 ${code} 已恢复可用`;
          }
        }
      }
      else if (data.startsWith("del_card_")) {
        const code = data.replace("del_card_", "");
        await env.SUB_STORE.delete(`card_${code}`);
        await logAction(env, "删除卡密", code);
        replyAlert = `🗑️ 卡密 ${code} 已删除`;
      }

      // 禁用/启用/删除用户
      else if (data.startsWith("disable_") || data.startsWith("enable_") || data.startsWith("del_")) {
        const [action, uid] = data.split("_");
        const userDataStr = await env.SUB_STORE.get(`user_${uid}`);
        if (!userDataStr) {
          replyAlert = `❌ 用户 UID:${uid} 不存在`;
        } else {
          const u = JSON.parse(userDataStr);
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
            const delId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            await env.SUB_STORE.put(`revoke_del_${delId}`, JSON.stringify({ uid, data: JSON.parse(userDataStr), time: Date.now() }), { expirationTtl: 86400 });
            await env.SUB_STORE.delete(`user_${uid}`);
            await clearUserCache(env, uid);
            await unindexUserChatId(env, u.chatId);
            await logAction(env, "删除用户", `UID:${uid} ChatID:${u.chatId || "-"}`);
            replyText = `🗑️ 用户 [${uid}] 已删除！\n\n如需恢复请点击下方按钮：`;
            replyMarkup = { inline_keyboard: [[{ text: "↩️ 恢复用户", callback_data: `undel_${uid}` }]] };
          }
        }
      }

      // 用户列表翻页
      else if (data.startsWith("ulist_")) {
        const allUsers = (await listAllKeys(env, "user_", 10000)).map(k => k.replace("user_", ""));
        const totalPages = Math.max(1, Math.ceil(allUsers.length / 5));
        const page = Math.max(1, Math.min(parseInt(data.replace("ulist_", "")) || 1, totalPages));
        const pageUsers = allUsers.slice((page - 1) * 5, (page - 1) * 5 + 5);

        let listText = `👥 【用户列表】 (第 ${page}/${totalPages} 页)\n\n`;
        const rows = [];
        for (const uid of pageUsers) {
          const u = JSON.parse(await env.SUB_STORE.get(`user_${uid}`));
          const remainDays = Math.ceil((u.expiry - Date.now()) / 86400000);
          const state = u.status === "disabled" ? "🔴" : (remainDays <= 0 ? "⏳" : "🟢");
          listText += `${state} UID:${uid} | 剩 ${Math.max(0, remainDays)} 天${u.note ? ` | 📝${u.note.slice(0, 10)}` : ""}\n`;
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

      // 用户详情
      else if (data.startsWith("check_")) {
        const checkUid = data.replace("check_", "");
        const checkStr = await env.SUB_STORE.get(`user_${checkUid}`);
        if (!checkStr) {
          replyAlert = `❌ 用户 UID:${checkUid} 不存在`;
        } else {
          const cu = JSON.parse(checkStr);
          const { remainDays, stateDesc } = userSummary(cu, checkUid);
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

      // 用户操作面板
      else if (data.startsWith("ops_")) {
        const opsUid = data.replace("ops_", "");
        const opsStr = await env.SUB_STORE.get(`user_${opsUid}`);
        if (!opsStr) {
          replyAlert = `❌ 用户 UID:${opsUid} 不存在`;
        } else {
          const ou = JSON.parse(opsStr);
          const { remainDays, stateDesc } = userSummary(ou, opsUid);
          const upStatus = ou.upstreamUrl ? "🎯 已指定" : "🔄 自动分配";
          replyText = `📊 【用户: ${opsUid}】\n• 状态: ${stateDesc}\n• 剩余: ${Math.max(0, remainDays)} 天\n• 到期: ${new Date(ou.expiry).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })}\n• ChatID: ${ou.chatId || "-"}\n${ou.note ? `• 备注: ${ou.note}\n` : ""}• 上游: ${upStatus}\n\n请选择操作：`;
          replyMarkup = opsButtons(opsUid);
          replyMarkup.inline_keyboard.push([{ text: "◀️ 返回", callback_data: "sc_list" }]);
        }
      }

      // 订阅链接
      else if (data.startsWith("link_")) {
        const linkUid = data.replace("link_", "");
        const origin = new URL(request.url).origin;
        replyText = `🔗 【订阅链接】\nUID: ${linkUid}\n\n• 普通订阅: ${origin}/s/${linkUid}\n• 兼容订阅: ${origin}/s/${linkUid}?legacy=1\n• YAML订阅: ${origin}/s/${linkUid}?yaml=1`;
      }

      // 用户快捷列表
      else if (data === "sc_list") {
        const scKeys = await listAllKeys(env, "user_", 5000);
        if (scKeys.length === 0) {
          replyAlert = "📭 当前没有任何用户";
        } else {
          const rows = [];
          let row = [];
          for (const k of scKeys) {
            row.push({ text: k.replace("user_", ""), callback_data: `ops_${k.replace("user_", "")}` });
            if (row.length === 3) { rows.push(row); row = []; }
          }
          if (row.length) rows.push(row);
          replyText = `👥 【用户列表】\n点击 UID 进入操作面板：\n\n（共 ${scKeys.length} 位用户）`;
          replyMarkup = { inline_keyboard: rows };
        }
      }

      // 用户选择器：pick_{mode}_{uid}
      else if (data.startsWith("pick_")) {
        const pickStr = data.replace("pick_", "");
        const mode = pickStr.split("_")[0];
        const pickUid = pickStr.slice(mode.length + 1);
        const pickUserStr = await env.SUB_STORE.get(`user_${pickUid}`);
        if (!pickUserStr) {
          replyAlert = `❌ 用户 UID:${pickUid} 不存在`;
        } else {
          const pu = JSON.parse(pickUserStr);
          if (mode === "adjust") {
            await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "adjust_days", uid: pickUid, chatId }));
            replyText = `⏱️ 【调整时长】\nUID:${pickUid}\n\n请输入调整天数：\n• 正数加时长（如 30）\n• 负数减时长（如 -30）\n• 直接设置到期：如 set 30 天`;
            replyMarkup = CANCEL_BTN;
          } else if (mode === "assign") {
            await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "assign_up", uid: pickUid, chatId }));
            const pool = await getUpstreamPool(env);
            const btns = pool.map((up, i) => ({ text: `${up.isDefault ? "⭐" : ""} ${up.note || "上游" + (i + 1)}`, callback_data: `assignup_${i}` }))
              .filter((b, i) => pool[i].status === "active")
              .map(b => [b]);
            btns.push([{ text: "↩️ 恢复自动分配", callback_data: "assignup_auto" }]);
            btns.push([{ text: "❌ 取消", callback_data: "cancel_action" }]);
            replyText = `🎯 【分配上游】\n用户 UID: ${pickUid} ${pu.upstreamUrl ? "（已指定）" : "（自动分配）"}\n\n请选择要分配的上游：`;
            replyMarkup = { inline_keyboard: btns };
          } else if (mode === "note") {
            await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "note_text", uid: pickUid, chatId }));
            replyText = `📝 【用户备注】\nUID:${pickUid}\n\n请输入备注内容（如：VIP老客户）：`;
            replyMarkup = CANCEL_BTN;
          } else if (mode === "msg") {
            await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "msg_text", uid: pickUid, chatId }));
            replyText = `💬 【私信用户】\nUID:${pickUid}\n\n请输入要发送的消息内容：`;
            replyMarkup = CANCEL_BTN;
          } else if (mode === "del") {
            const delId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            await env.SUB_STORE.put(`revoke_del_${delId}`, JSON.stringify({ uid: pickUid, data: JSON.parse(pickUserStr), time: Date.now() }), { expirationTtl: 86400 });
            await env.SUB_STORE.delete(`user_${pickUid}`);
            await clearUserCache(env, pickUid);
            await unindexUserChatId(env, pu.chatId);
            await logAction(env, "删除用户", `UID:${pickUid} ChatID:${pu.chatId || "-"}`);
            replyText = `🗑️ 用户 [${pickUid}] 已删除！\n\n如需恢复请点击下方按钮：`;
            replyMarkup = { inline_keyboard: [[{ text: "↩️ 恢复用户", callback_data: `undel_${pickUid}` }]] };
          } else if (mode === "ops") {
            const { remainDays, stateDesc } = userSummary(pu, pickUid);
            const origin = new URL(request.url).origin;
            replyText = `📊 【用户: ${pickUid}】\n• 状态: ${stateDesc}\n• 剩余: ${Math.max(0, remainDays)} 天\n• 到期: ${new Date(pu.expiry).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })}\n• ChatID: ${pu.chatId || "-"}\n${pu.note ? `• 备注: ${pu.note}\n` : ""}\n\n请选择操作：`;
            replyMarkup = opsButtons(pickUid);
          } else {
            replyAlert = "❌ 未知操作";
          }
        }
      }

      // 手动开卡：选择天数
      else if (data.startsWith("newuser_days_")) {
        const val = data.replace("newuser_days_", "");
        if (val === "custom") {
          replyText = `➕ 【手动开卡】\n请发送开通天数（如 45）：\n\n> 也可直接指定到期日期，格式：\n> \`到期 2026-12-31\``;
          await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "newuser_days_custom", chatId }));
          replyMarkup = CANCEL_BTN;
        } else {
          const days = parseInt(val);
          replyText = `➕ 【手动开卡】\n请发送需要开通的聊天 ID（买家 ChatID）：\n\n（将开通 ${days} 天）\n\n> 格式：直接发送数字即可`;
          await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "newuser", days, chatId }));
          replyMarkup = CANCEL_BTN;
        }
      }

      // 设置默认时长
      else if (data.startsWith("setdays_")) {
        const val = data.replace("setdays_", "");
        if (val === "custom") {
          replyText = "📅 【设置默认时长】\n请直接发送天数（如 45）：";
          await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "set_days", chatId }));
          replyMarkup = CANCEL_BTN;
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

      // 生成卡密：选数量
      else if (data.startsWith("gencard_qty_")) {
        const val = data.replace("gencard_qty_", "");
        if (val === "custom") {
          replyText = "➕ 【生成卡密】\n请直接发送数量（1-200）：";
          await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "gencard_qty", chatId }));
          replyMarkup = CANCEL_BTN;
        } else {
          const qty = parseInt(val);
          if (isNaN(qty) || qty <= 0 || qty > 200) {
            replyAlert = "❌ 数量无效（1-200）";
          } else {
            replyText = `➕ 【生成卡密】\n数量: ${qty} 张\n\n请选择卡密时长：`;
            await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "gencard_days", qty, chatId }));
            replyMarkup = daysBtns("gencard_days");
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
          replyMarkup = CANCEL_BTN;
        } else {
          const days = parseInt(val);
          if (isNaN(days) || days <= 0) {
            replyAlert = "❌ 无效天数";
          } else {
            const price = (await env.SUB_STORE.get("price_info")) || "";
            const cards = await genCards(env, qty, days, `${days} 天套餐`, price);
            await sendCodes(ADMIN_BOT_TOKEN, chatId, cards.map(c => c.code));
            await env.SUB_STORE.delete("admin_action_state");
            replyText = `✅ 已生成 ${qty} 张卡密（${days} 天）\n\n买家在 @${getStoreBotUsername()} 点【🎫 兑换卡密】即可兑换！`;
          }
        }
      }

      // 分配上游（从 /check 面板）
      else if (data.startsWith("assign_")) {
        const targetUid = data.replace("assign_", "");
        const userDataStr = await env.SUB_STORE.get(`user_${targetUid}`);
        if (!userDataStr) {
          replyText = `❌ 用户 UID:${targetUid} 不存在`;
        } else {
          const u = JSON.parse(userDataStr);
          await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "assign_up", uid: targetUid, chatId }));
          const pool = await getUpstreamPool(env);
          const btns = pool.map((up, i) => ({ text: `${up.isDefault ? "⭐" : ""} ${up.note || "上游" + (i + 1)}`, callback_data: `assignup_${i}` }))
            .filter((b, i) => pool[i].status === "active")
            .map(b => [b]);
          btns.push([{ text: "↩️ 恢复自动分配", callback_data: "assignup_auto" }]);
          btns.push([{ text: "❌ 取消", callback_data: "cancel_action" }]);
          replyText = `🎯 【分配上游】\n用户 UID: ${targetUid} ${u.upstreamUrl ? "（已指定）" : "（自动分配）"}\n\n请选择要分配的上游：`;
          replyMarkup = { inline_keyboard: btns };
        }
      }

      // 选择上游
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
              await clearUserCache(env, targetUid);
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
                await clearUserCache(env, targetUid);
                await env.SUB_STORE.delete("admin_action_state");
                await logAction(env, "分配上游", `UID:${targetUid} → ${up.note || up.url.slice(0, 30)}`);
                replyText = `✅ 已为用户 [${targetUid}] 分配专属上游！\n\n📡 ${up.note || "上游" + (upIdx + 1)}\n${up.url}\n\n该用户订阅将使用此线路。`;
              }
            }
          }
        }
      }

      // 取消操作
      else if (data === "cancel_action") {
        await env.SUB_STORE.delete("admin_action_state");
        if (cb.message && cb.message.message_id) {
          try { await delMsg(ADMIN_BOT_TOKEN, cb.message.chat.id, cb.message.message_id); } catch (e) {}
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

      // 分销商列表
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

      // 系统概览
      else if (data === "sys_overview") {
        replyText = await buildOverview(env);
      }

      // 待审核订单：翻页
      else if (data.startsWith("pending_list_page_")) {
        const pg = parseInt(data.replace("pending_list_page_", "")) || 1;
        await sendPendingOrders(env, chatId, pg, cb.message.message_id);
        replyText = "";
      }

      // 待审核订单：管理员取消订单
      else if (data.startsWith("cancel_pending_")) {
        const oid = data.replace("cancel_pending_", "");
        let buyerChat = null;
        const oStr = await env.SUB_STORE.get(`pending_${oid}`);
        if (oStr) { try { buyerChat = JSON.parse(oStr).chatId; } catch (e) {} }
        await env.SUB_STORE.delete(`pending_${oid}`);
        await logAction(env, "取消订单", `订单:${oid} 买家:${buyerChat || "?"}`);
        replyAlert = `🚫 订单 ${oid} 已取消`;
        if (buyerChat) {
          try { await sendText(STORE_BOT_TOKEN, buyerChat, `❌ 您的订单 ${oid} 已被管理员取消。\n如已付款请联系客服。`); } catch (e) {}
        }
      }

      // ===== 套餐管理回调 =====
      else if (data === "plans_add") {
        await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "plan_name", chatId }));
        replyText = `📦 【添加套餐 · 第 1/3 步】\n请发送套餐名称（如：半年卡）：`;
        replyMarkup = CANCEL_BTN;
      }
      else if (data.startsWith("plans_toggle_")) {
        const pId = data.replace("plans_toggle_", "");
        const plans = await getPlans(env);
        const p = plans.find(x => x.id === pId);
        if (p) {
          p.enabled = p.enabled === false;
          await savePlans(env, plans);
          await logAction(env, p.enabled === false ? "停用套餐" : "启用套餐", p.name);
          await showPlanManage(env, chatId, cb.message.message_id);
          replyAlert = `✅ 套餐「${p.name}」已${p.enabled === false ? "停用" : "启用"}`;
        } else {
          replyAlert = "❌ 套餐不存在";
        }
      }
      else if (data.startsWith("plans_del_")) {
        const pId = data.replace("plans_del_", "");
        const plans = await getPlans(env);
        if (plans.length <= 1) {
          replyAlert = "❌ 至少保留 1 个套餐，无法删除";
        } else {
          const idx = plans.findIndex(x => x.id === pId);
          if (idx === -1) {
            replyAlert = "❌ 套餐不存在";
          } else {
            const removed = plans.splice(idx, 1)[0];
            await savePlans(env, plans);
            await logAction(env, "删除套餐", `${removed.name} (${removed.days}天/${removed.price})`);
            await showPlanManage(env, chatId, cb.message.message_id);
            replyAlert = `🗑️ 套餐「${removed.name}」已删除`;
          }
        }
      }

      if (replyText) {
        await editMsg(ADMIN_BOT_TOKEN, cb.message.chat.id, cb.message.message_id, replyText, replyMarkup);
      } else if (replyAlert) {
        await answerCb(ADMIN_BOT_TOKEN, cb.id, replyAlert);
      } else {
        await answerCb(ADMIN_BOT_TOKEN, cb.id, "✅ 已处理");
      }
      return new Response("OK");
    }

    // ===== 文本/图片消息处理 =====
    const msg = update.message;
    if (!msg || msg.from.id !== ADMIN_ID) return new Response("OK");

    const chatId = msg.chat.id;
    const text = msg.text || "";

    const actionStateStr = await env.SUB_STORE.get("admin_action_state");
    let actionState = null;
    if (actionStateStr) {
      try { actionState = JSON.parse(actionStateStr); } catch (e) {}
    }

    const state = (mode) => actionState && actionState.mode === mode;
    const setState = (obj) => env.SUB_STORE.put("admin_action_state", JSON.stringify({ ...obj, chatId }));

    // ===== 状态机流程（公共处理） =====
    // 手动开卡：自定义天数
    if (state("newuser_days_custom")) {
      const input = text.trim();
      let days = null;
      let tip = "";
      let targetExpiry = null;
      if (/^\d+$/.test(input)) {
        days = parseInt(input);
        tip = `（自定义 ${days} 天）`;
      } else if (/^到期\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.test(input)) {
        const m = input.match(/^到期\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
        const y = parseInt(m[1]), mo = parseInt(m[2]), d = parseInt(m[3]);
        if (mo < 1 || mo > 12 || d < 1 || d > 31) {
          await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 日期格式无效，示例：到期 2026-12-31", MAIN_MENU);
          return new Response("OK");
        }
        const expireDate = new Date(y, mo - 1, d);
        if (isNaN(expireDate.getTime()) || expireDate.getDate() !== d || expireDate.getMonth() !== mo - 1) {
          await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 日期格式无效，示例：到期 2026-12-31", MAIN_MENU);
          return new Response("OK");
        }
        expireDate.setHours(23, 59, 59, 999);
        if (expireDate.getTime() < Date.now()) {
          await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 到期日期不能是过去的时间，请重新输入", MAIN_MENU);
          return new Response("OK");
        }
        targetExpiry = expireDate.getTime();
        days = Math.max(1, Math.ceil((targetExpiry - Date.now()) / 86400000));
        tip = `（自定义到期 ${m[1]}-${m[2]}-${m[3]}，共 ${days} 天）`;
      } else {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 输入无效\n\n请发送天数（如 45）\n或指定到期日期（如：到期 2026-12-31）", MAIN_MENU);
        return new Response("OK");
      }
      if (days <= 0) { await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 天数必须大于 0", MAIN_MENU); return new Response("OK"); }
      if (days > 3650) { await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 天数过大（最多 3650 天）", MAIN_MENU); return new Response("OK"); }

      await setState({ mode: "newuser", days, targetExpiry });
      await sendMenu(ADMIN_BOT_TOKEN, chatId, `➕ 【手动开卡】\n请发送需要开通的聊天 ID（买家 ChatID）：\n\n${tip}\n\n> 格式：直接发送数字即可`, CANCEL_BTN);
      return new Response("OK");
    }

    // 手动开卡：等待 ChatID
    if (state("newuser") && /^\d+$/.test(text)) {
      const targetChatId = parseInt(text);
      if (!Number.isSafeInteger(targetChatId)) {
        await env.SUB_STORE.delete("admin_action_state");
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ ChatID 无效，请输入正确的数字", MAIN_MENU);
        return new Response("OK");
      }
      const existingByChat = await findUidByChatId(env, targetChatId);
      if (existingByChat) {
        await env.SUB_STORE.delete("admin_action_state");
        await sendMenu(ADMIN_BOT_TOKEN, chatId,
          `⚠️ 该 ChatID 已有订阅（UID:${existingByChat}）\n\n如需续费请用「⏱️ 调整时长」给该用户加时长，避免重复开卡产生两个账号。`,
          MAIN_MENU);
        return new Response("OK");
      }
      const days = actionState.days;
      const upstream = await getDefaultUpstream(env);
      if (!upstream) {
        await env.SUB_STORE.delete("admin_action_state");
        await sendMenu(ADMIN_BOT_TOKEN, chatId,
          "❌ 尚未配置上游订阅源，无法开卡！\n\n请先用 /addurl 链接 添加上游，再执行手动开卡。", MAIN_MENU);
        return new Response("OK");
      }
      const newUid = await genUniqueUid(env);
      const expiry = actionState.targetExpiry || (Date.now() + (days * 86400000));
      await env.SUB_STORE.put(`user_${newUid}`, JSON.stringify({
        upstreamUrl: upstream, expiry, status: "active",
        brand: DEFAULT_BRAND, chatId: targetChatId, createdAt: Date.now(), plan: `${days} 天套餐`
      }));
      await indexUserChatId(env, targetChatId, newUid);
      const subLink = `${new URL(request.url).origin}/s/${newUid}`;
      await sendText(STORE_BOT_TOKEN, targetChatId, `🎉 【开通成功】\n您的专属订阅已开通！\n\n🔗 专属短链:\n\`${subLink}\`\n\n服务时长: ${days} 天`);
      await env.SUB_STORE.delete("admin_action_state");

      const mId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      await env.SUB_STORE.put(`revoke_manual_${mId}`, JSON.stringify({ uid: newUid, isNew: true, chatId: targetChatId, time: Date.now() }), { expirationTtl: 86400 });
      await sendMenu(ADMIN_BOT_TOKEN, chatId,
        `✅ 【手动开卡成功】\n\n• 新 UID: \`${newUid}\`\n• 时长: ${days} 天\n• 买家 ChatID: ${targetChatId}\n• 订阅链接: ${subLink}\n\n已通知买家。\n如需撤销请点击下方按钮：`,
        { inline_keyboard: [[{ text: "↩️ 撤销本次开卡", callback_data: `revoke_manual_${mId}` }]] });
      return new Response("OK");
    }

    // 分配上游：输入 UID
    if (state("assign_uid") && /^\d+$/.test(text)) {
      const targetUid = text.trim();
      const userDataStr = await env.SUB_STORE.get(`user_${targetUid}`);
      if (!userDataStr) {
        await env.SUB_STORE.delete("admin_action_state");
        await sendMenu(ADMIN_BOT_TOKEN, chatId, `❌ 用户 UID:${targetUid} 不存在`, MAIN_MENU);
      } else {
        const u = JSON.parse(userDataStr);
        await setState({ mode: "assign_up", uid: targetUid });
        const pool = await getUpstreamPool(env);
        const btns = pool.map((up, i) => ({ text: `${up.isDefault ? "⭐" : ""} ${up.note || "上游" + (i + 1)}`, callback_data: `assignup_${i}` }))
          .filter((b, i) => pool[i].status === "active")
          .map(b => [b]);
        btns.push([{ text: "↩️ 恢复自动分配", callback_data: "assignup_auto" }]);
        btns.push([{ text: "❌ 取消", callback_data: "cancel_action" }]);
        await sendMenu(ADMIN_BOT_TOKEN, chatId,
          `🎯 【分配上游】\n用户 UID: ${targetUid} ${u.upstreamUrl ? "（当前已指定）" : "（当前为自动分配）"}\n\n请选择要分配的上游：`,
          { inline_keyboard: btns });
      }
      return new Response("OK");
    }

    // 搜索用户
    if (state("search_user")) {
      const keyword = text.trim().toLowerCase();
      await env.SUB_STORE.delete("admin_action_state");
      if (!keyword) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 关键词无效", MAIN_MENU);
      } else {
        const matches = [];
        for (const k of await listAllKeys(env, "user_", 10000)) {
          const u = JSON.parse(await env.SUB_STORE.get(k));
          const haystack = `${k.replace("user_", "")} ${u.note || ""} ${u.plan || ""} ${u.chatId || ""}`.toLowerCase();
          if (haystack.includes(keyword)) matches.push({ uid: k.replace("user_", ""), u });
        }
        if (matches.length === 0) {
          await sendMenu(ADMIN_BOT_TOKEN, chatId, `🔎 未找到匹配"${text.trim()}"的用户`, MAIN_MENU);
        } else {
          let msg = `🔎 【搜索结果】(${matches.length} 个)\n\n`;
          for (const m of matches.slice(0, 15)) {
            const remain = Math.ceil((m.u.expiry - Date.now()) / 86400000);
            const stateIcon = m.u.status === "disabled" ? "🔴" : (remain <= 0 ? "⏳" : "🟢");
            msg += `${stateIcon} UID:${m.uid} | 剩 ${Math.max(0, remain)} 天${m.u.note ? ` | 📝${m.u.note.slice(0, 12)}` : ""}\n`;
          }
          if (matches.length > 15) msg += `\n...还有 ${matches.length - 15} 个`;
          await sendMenu(ADMIN_BOT_TOKEN, chatId, msg, MAIN_MENU);
        }
      }
      return new Response("OK");
    }

    // 私信用户：输入 UID
    if (state("msg_uid") && /^\d+$/.test(text)) {
      const targetUid = text.trim();
      const userDataStr = await env.SUB_STORE.get(`user_${targetUid}`);
      if (!userDataStr) {
        await env.SUB_STORE.delete("admin_action_state");
        await sendMenu(ADMIN_BOT_TOKEN, chatId, `❌ 用户 UID:${targetUid} 不存在`, MAIN_MENU);
      } else {
        await setState({ mode: "msg_text", uid: targetUid });
        await sendMenu(ADMIN_BOT_TOKEN, chatId, `💬 【私信用户】\nUID:${targetUid}\n\n请输入要发送的消息内容：`, CANCEL_BTN);
      }
      return new Response("OK");
    }

    // 私信用户：输入内容
    if (state("msg_text")) {
      const { uid } = actionState;
      const userDataStr = await env.SUB_STORE.get(`user_${uid}`);
      await env.SUB_STORE.delete("admin_action_state");
      if (!userDataStr) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, `❌ 用户 UID:${uid} 不存在`, MAIN_MENU);
      } else {
        const u = JSON.parse(userDataStr);
        if (!u.chatId) {
          await sendMenu(ADMIN_BOT_TOKEN, chatId, `❌ 用户 UID:${uid} 没有绑定的 ChatID，无法私信`, MAIN_MENU);
        } else {
          try {
            await sendText(STORE_BOT_TOKEN, u.chatId, `💬 【管理员消息】\n${text}`);
            await sendMenu(ADMIN_BOT_TOKEN, chatId, `✅ 【私信已发送】\nUID:${uid} (ChatID:${u.chatId})\n\n内容:\n${text}`, MAIN_MENU);
          } catch (e) {
            await sendMenu(ADMIN_BOT_TOKEN, chatId, `❌ 发送失败，用户可能未与前台 Bot 建立会话`, MAIN_MENU);
          }
        }
      }
      return new Response("OK");
    }

    // 调整时长：输入 UID
    if (state("adjust_uid") && /^\d+$/.test(text)) {
      const targetUid = text.trim();
      const userDataStr = await env.SUB_STORE.get(`user_${targetUid}`);
      if (!userDataStr) {
        await env.SUB_STORE.delete("admin_action_state");
        await sendMenu(ADMIN_BOT_TOKEN, chatId, `❌ 用户 UID:${targetUid} 不存在`, MAIN_MENU);
      } else {
        await setState({ mode: "adjust_days", uid: targetUid });
        await sendMenu(ADMIN_BOT_TOKEN, chatId,
          `⏱️ 【调整时长】\nUID:${targetUid}\n\n请输入调整天数：\n• 正数加时长（如 30）\n• 负数减时长（如 -30）\n• 直接设置到期：如 set 30 天`,
          CANCEL_BTN);
      }
      return new Response("OK");
    }

    // 调整时长：输入天数
    if (state("adjust_days")) {
      const { uid } = actionState;
      const userDataStr = await env.SUB_STORE.get(`user_${uid}`);
      if (!userDataStr) {
        await env.SUB_STORE.delete("admin_action_state");
        await sendMenu(ADMIN_BOT_TOKEN, chatId, `❌ 用户 UID:${uid} 不存在`, MAIN_MENU);
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
          u.expiry = Math.min(u.expiry, base + (delta * 86400000));
          if (u.expiry < Date.now()) u.expiry = Date.now() + 86400000;
        }
        u.status = "active";
        await env.SUB_STORE.put(`user_${uid}`, JSON.stringify(u));
        await env.SUB_STORE.delete("admin_action_state");

        const adjId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        await env.SUB_STORE.put(`revoke_adjust_${adjId}`, JSON.stringify({ uid, prevExpiry, delta, time: Date.now() }), { expirationTtl: 86400 });
        const newRemain = Math.ceil((u.expiry - Date.now()) / 86400000);
        await sendMenu(ADMIN_BOT_TOKEN, chatId,
          `✅ 【时长已调整】\nUID:${uid}\n调整: ${delta > 0 ? "+" : ""}${delta} 天\n当前剩余: ${Math.max(0, newRemain)} 天\n到期: ${new Date(u.expiry).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })}\n\n如需撤销请点击下方按钮：`,
          { inline_keyboard: [[{ text: "↩️ 撤销本次调整", callback_data: `revoke_adjust_${adjId}` }]] });
        return new Response("OK");
      } else if (/^set\s+(\d+)\s*天?$/.test(input)) {
        const days = parseInt(input.match(/^set\s+(\d+)\s*天?$/)[1]);
        if (days <= 0 || days > 3650) {
          await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 天数无效（1-3650）", MAIN_MENU);
          return new Response("OK");
        }
        u.expiry = Date.now() + (days * 86400000);
        u.status = "active";
        await env.SUB_STORE.put(`user_${uid}`, JSON.stringify(u));
        await env.SUB_STORE.delete("admin_action_state");
        const adjId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        await env.SUB_STORE.put(`revoke_adjust_${adjId}`, JSON.stringify({ uid, prevExpiry, delta: days, time: Date.now() }), { expirationTtl: 86400 });
        await sendMenu(ADMIN_BOT_TOKEN, chatId,
          `✅ 【到期时间已设置】\nUID:${uid}\n设为剩余 ${days} 天\n到期: ${new Date(u.expiry).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })}\n\n如需撤销请点击下方按钮：`,
          { inline_keyboard: [[{ text: "↩️ 撤销本次调整", callback_data: `revoke_adjust_${adjId}` }]] });
        return new Response("OK");
      } else {
        await env.SUB_STORE.delete("admin_action_state");
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 输入无效，已取消操作", MAIN_MENU);
      }
      return new Response("OK");
    }

    // 用户备注：输入 UID
    if (state("note_uid") && /^\d+$/.test(text)) {
      const targetUid = text.trim();
      const userDataStr = await env.SUB_STORE.get(`user_${targetUid}`);
      if (!userDataStr) {
        await env.SUB_STORE.delete("admin_action_state");
        await sendMenu(ADMIN_BOT_TOKEN, chatId, `❌ 用户 UID:${targetUid} 不存在`, MAIN_MENU);
      } else {
        await setState({ mode: "note_text", uid: targetUid });
        await sendMenu(ADMIN_BOT_TOKEN, chatId, `📝 【用户备注】\nUID:${targetUid}\n\n请输入备注内容（如：VIP老客户）：`, CANCEL_BTN);
      }
      return new Response("OK");
    }

    // 用户备注：输入内容
    if (state("note_text")) {
      const { uid } = actionState;
      const userDataStr = await env.SUB_STORE.get(`user_${uid}`);
      if (userDataStr) {
        const u = JSON.parse(userDataStr);
        u.note = text.trim();
        await env.SUB_STORE.put(`user_${uid}`, JSON.stringify(u));
        await env.SUB_STORE.delete("admin_action_state");
        await sendMenu(ADMIN_BOT_TOKEN, chatId, `✅ 【备注已保存】\nUID:${uid}\n备注: ${text.trim()}`, MAIN_MENU);
      } else {
        await env.SUB_STORE.delete("admin_action_state");
        await sendMenu(ADMIN_BOT_TOKEN, chatId, `❌ 用户 UID:${uid} 不存在`, MAIN_MENU);
      }
      return new Response("OK");
    }

    // 发布公告
    if (state("notice")) {
      const content = text.trim();
      await env.SUB_STORE.delete("admin_action_state");
      if (content) {
        await env.SUB_STORE.put("notice_content", content);
        await sendMenu(ADMIN_BOT_TOKEN, chatId, `✅ 【公告已发布】\n\n${content}\n\n买家在前台 Bot 发送 /start 即可看到。`, MAIN_MENU);
      } else {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 公告内容为空，已取消", MAIN_MENU);
      }
      return new Response("OK");
    }

    // 设置价格
    if (state("set_price")) {
      const price = text.trim();
      await env.SUB_STORE.delete("admin_action_state");
      if (!price) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 价格内容无效", MAIN_MENU);
      } else {
        await env.SUB_STORE.put("price_info", price);
        await sendMenu(ADMIN_BOT_TOKEN, chatId, `✅ 【套餐价格已设置】\n${price}`, MAIN_MENU);
      }
      return new Response("OK");
    }

    // 设置默认时长
    if (state("set_days")) {
      const days = parseInt(text.trim());
      await env.SUB_STORE.delete("admin_action_state");
      if (isNaN(days) || days <= 0) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 无效天数，已取消", MAIN_MENU);
      } else {
        await env.SUB_STORE.put("default_days", days.toString());
        await sendMenu(ADMIN_BOT_TOKEN, chatId, `✅ 【默认时长已设置】\n${days} 天`, MAIN_MENU);
      }
      return new Response("OK");
    }

    // 生成卡密：自定义数量
    if (state("gencard_qty")) {
      const qty = parseInt(text.trim());
      await env.SUB_STORE.delete("admin_action_state");
      if (isNaN(qty) || qty <= 0 || qty > 200) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 数量无效（1-200）", MAIN_MENU);
      } else {
        await setState({ mode: "gencard_days", qty });
        await sendMenu(ADMIN_BOT_TOKEN, chatId, `➕ 【生成卡密】\n数量: ${qty} 张\n\n请选择卡密时长：`, daysBtns("gencard_days"));
      }
      return new Response("OK");
    }

    // 生成卡密：自定义天数
    if (state("gencard_days_custom")) {
      const days = parseInt(text.trim());
      const qty = actionState.qty || 10;
      await env.SUB_STORE.delete("admin_action_state");
      if (isNaN(days) || days <= 0 || days > 3650) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 无效天数（1-3650）", MAIN_MENU);
      } else {
        const price = (await env.SUB_STORE.get("price_info")) || "";
        const cards = await genCards(env, qty, days, `${days} 天套餐`, price);
        await sendCodes(ADMIN_BOT_TOKEN, chatId, cards.map(c => c.code));
        await sendMenu(ADMIN_BOT_TOKEN, chatId,
          `✅ 已生成 ${qty} 张卡密（${days} 天）\n\n买家在 @${getStoreBotUsername()} 点【🎫 兑换卡密】即可兑换！`,
          MAIN_MENU);
      }
      return new Response("OK");
    }

    // 佣金比例
    if (state("comm_pct")) {
      const rate = parseFloat(text.trim());
      await env.SUB_STORE.delete("admin_action_state");
      if (isNaN(rate) || rate < 0 || rate > 100) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 无效比例，请输入 0-100 的数字", MAIN_MENU);
      } else {
        await env.SUB_STORE.put("comm_rate", rate.toString());
        await sendMenu(ADMIN_BOT_TOKEN, chatId, `✅ 【佣金比例已设置】\n佣金: ${rate}%`, MAIN_MENU);
      }
      return new Response("OK");
    }

    // 群发通知（带二次确认，防误发）
    if (state("broadcast")) {
      const content = text.trim();
      if (content === "✅ 确认群发") {
        const userKeys = await listAllKeys(env, "user_", 10000);
        let sentCount = 0;
        const draft = actionState.draft || "";
        for (const k of userKeys) {
          const u = JSON.parse(await env.SUB_STORE.get(k));
          if (u.chatId) {
            try { await sendText(STORE_BOT_TOKEN, u.chatId, `📢 ${draft}`); sentCount++; } catch (e) {}
          }
        }
        await env.SUB_STORE.delete("admin_action_state");
        await sendMenu(ADMIN_BOT_TOKEN, chatId, `✅ 【群发完成】\n已发送给 ${sentCount} 位用户`, MAIN_MENU);
      } else if (content === "❌ 取消群发" || content === "取消") {
        await env.SUB_STORE.delete("admin_action_state");
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 已取消群发", MAIN_MENU);
      } else if (!content) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 内容为空，已取消", MAIN_MENU);
        await env.SUB_STORE.delete("admin_action_state");
      } else {
        const userKeys = await listAllKeys(env, "user_", 10000);
        let targetCount = 0;
        for (const k of userKeys) {
          try { if (JSON.parse(await env.SUB_STORE.get(k)).chatId) targetCount++; } catch (e) {}
        }
        await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "broadcast", draft: content, chatId }));
        await sendMenu(ADMIN_BOT_TOKEN, chatId,
          `📣 【群发预览】\n\n将发送给 ${targetCount} 位已绑定用户：\n\n${content}\n\n点击下方按钮确认发送，或取消：`,
          { keyboard: [[{ text: "✅ 确认群发" }, { text: "❌ 取消群发" }]], resize_keyboard: true, persistent: true });
      }
      return new Response("OK");
    }

    // 查询卡密
    if (state("card_query")) {
      const q = text.trim().toUpperCase();
      await env.SUB_STORE.delete("admin_action_state");
      if (!q) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 输入无效", MAIN_MENU);
        return new Response("OK");
      }
      const cardStr = await env.SUB_STORE.get(`card_${q}`);
      if (cardStr) {
        const c = JSON.parse(cardStr);
        const statusDesc = c.status === "used" ? `已使用 🔵\n使用人: ${c.usedBy}\n使用时间: ${new Date(c.usedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}` : (c.status === "disabled" ? "已禁用 🔴" : "未使用 🟢");
        const btns = [];
        if (c.status === "used") {
          btns.push([{ text: "🗑️ 删除此卡密", callback_data: `del_card_${c.code}` }]);
        } else if (c.status === "disabled") {
          btns.push([{ text: "🟢 启用此卡密", callback_data: `enable_card_${c.code}` }]);
        } else {
          btns.push([
            { text: "🔴 禁用此卡密", callback_data: `disable_card_${c.code}` },
            { text: "🗑️ 删除", callback_data: `del_card_${c.code}` }
          ]);
        }
        await sendMenu(ADMIN_BOT_TOKEN, chatId,
          `🎫 【卡密信息】\n\n• 卡密: \`${c.code}\`\n• 套餐: ${c.planName}\n• 时长: ${c.days} 天\n• 价格: ${c.price || "未设置"}\n• 状态: ${statusDesc}`,
          { inline_keyboard: btns });
      } else {
        const matches = [];
        for (const k of await listAllKeys(env, "card_", 10000)) {
          const c = JSON.parse(await env.SUB_STORE.get(k));
          if (c.code.includes(q)) matches.push(c);
        }
        if (matches.length > 0) {
          let msg = `🔍 【匹配 ${matches.length} 张卡密】\n\n`;
          for (const m of matches.slice(0, 10)) msg += `• ${m.code} - ${m.status === "used" ? "已用" : (m.status === "disabled" ? "禁用" : "未用")} (${m.days}天)\n`;
          await sendMenu(ADMIN_BOT_TOKEN, chatId, msg, MAIN_MENU);
        } else {
          await sendMenu(ADMIN_BOT_TOKEN, chatId, `❌ 未找到卡密: ${q}`, MAIN_MENU);
        }
      }
      return new Response("OK");
    }

    // 设置 USDT 汇率
    if (state("usdt_rate")) {
      const rate = parseFloat(text.trim());
      await env.SUB_STORE.delete("admin_action_state");
      if (isNaN(rate) || rate <= 0) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 汇率无效，请输入大于 0 的数字（如 7.2）", MAIN_MENU);
      } else {
        await saveUsdtRate(env, rate);
        await sendMenu(ADMIN_BOT_TOKEN, chatId,
          `✅ 【USDT 汇率已设置】\n1 USDT = ¥${rate}\n\n买家选 USDT 付款时，套餐金额将按此汇率折算成 USDT 显示。`,
          MAIN_MENU);
      }
      return new Response("OK");
    }

    // 配置 USDT 地址
    if (state("usdt_address")) {
      const input = text.trim();
      await env.SUB_STORE.delete("admin_action_state");
      if (!input) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 输入无效，已取消", MAIN_MENU);
      } else {
        const parts = input.split(/\s+/);
        const address = parts[0];
        const network = parts.slice(1).join(" ") || "TRC20";
        await saveUsdtInfo(env, address, network);
        await sendMenu(ADMIN_BOT_TOKEN, chatId,
          `✅ 【USDT 地址已设置】\n\n地址: \`${address}\`\n网络: ${network}\n\n买家选择 USDT 支付时将看到此信息。`,
          MAIN_MENU);
      }
      return new Response("OK");
    }

    // 支付方式管理（删除操作）
    if (state("pay_manage")) {
      const input = text.trim();
      await env.SUB_STORE.delete("admin_action_state");
      const dm = input.match(/^删(微信|支付宝)\s*(\d+)$/);
      if (dm) {
        const method = dm[1] === "微信" ? "wechat" : "alipay";
        const idx = parseInt(dm[2]) - 1;
        const r = await removePayQr(env, method, idx);
        await sendMenu(ADMIN_BOT_TOKEN, chatId, r.ok ? `✅ ${r.msg}` : `❌ ${r.msg}`, MAIN_MENU);
      } else if (input === "清空USDT" || input === "清空USDT地址") {
        await env.SUB_STORE.delete("pay_usdt");
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "✅ 已清空 USDT 地址", MAIN_MENU);
      } else {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 无效操作，已取消", MAIN_MENU);
      }
      return new Response("OK");
    }

    // 创建分销商：输入名称
    if (state("reseller_name")) {
      const name = text.trim();
      await env.SUB_STORE.delete("admin_action_state");
      if (!name) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 名称无效，已取消", MAIN_MENU);
      } else {
        const code = "R" + Math.floor(10000 + Math.random() * 90000);
        const id = Date.now().toString(36);
        await env.SUB_STORE.put(`reseller_${id}`, JSON.stringify({ code, name, commission: 0, clicks: 0, createdAt: Date.now() }));
        await sendMenu(ADMIN_BOT_TOKEN, chatId,
          `✅ 【分销商已创建】\n\n• 名称: ${name}\n• 邀请码: \`${code}\`\n• 推广链接: ${getStoreOrigin(request)}/r/${code}\n\n买家打开推广链接或使用邀请码购买，即可关联佣金。`,
          MAIN_MENU);
      }
      return new Response("OK");
    }

    // ===== 套餐管理：添加套餐流程 =====
    if (state("plan_name")) {
      const name = text.trim();
      if (!name) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 套餐名称无效，已取消", MAIN_MENU);
        await env.SUB_STORE.delete("admin_action_state");
      } else {
        await setState({ mode: "plan_days", name });
        await sendMenu(ADMIN_BOT_TOKEN, chatId,
          `📦 【添加套餐 · 第 2/3 步】\n套餐名称: ${name}\n\n请发送时长（天数，如 180）：`,
          CANCEL_BTN);
      }
      return new Response("OK");
    }
    if (state("plan_days")) {
      const days = parseInt(text.trim());
      if (isNaN(days) || days <= 0 || days > 3650) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 天数无效（1-3650），已取消", MAIN_MENU);
        await env.SUB_STORE.delete("admin_action_state");
      } else {
        await setState({ mode: "plan_price", name: actionState.name, days });
        await sendMenu(ADMIN_BOT_TOKEN, chatId,
          `📦 【添加套餐 · 第 3/3 步】\n套餐名称: ${actionState.name}\n时长: ${days} 天\n\n请发送价格（如：120元 或 120）：`,
          CANCEL_BTN);
      }
      return new Response("OK");
    }
    if (state("plan_price")) {
      const price = text.trim() || "联系客服";
      const plans = await getPlans(env);
      const newPlan = {
        id: Date.now().toString(36),
        name: actionState.name,
        days: actionState.days,
        price: price.replace(/^(元|¥|￥)/, ""),
        enabled: true
      };
      plans.push(newPlan);
      await savePlans(env, plans);
      await env.SUB_STORE.delete("admin_action_state");
      await logAction(env, "添加套餐", `${newPlan.name} (${newPlan.days}天/${newPlan.price})`);
      await showPlanManage(env, chatId);
      return new Response("OK");
    }

    // ===== 命令参数交互式引导（发命令 → Bot 引导 → 输入参数） =====
    // /nodeoff /nodeon 无参数
    if (state("node_toggle")) {
      const input = text.trim();
      const parts = input.split(/\s+/);
      const arg = parts[0];
      const upIdx = (parts[1] ? parseInt(parts[1]) : 1) - 1;
      if (isNaN(upIdx) || upIdx < 0) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, `❌ 无效格式\n请输入：节点序号 或 节点序号 上游序号\n例如：\`1,3,5\` 或 \`1,3,5 2\``, MAIN_MENU);
        return new Response("OK");
      }
      const action = actionState.action;
      await env.SUB_STORE.delete("admin_action_state");
      if (arg !== "all" && !/^[\d,\s]+$/.test(arg)) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, `❌ 无效输入\n\n请发送节点序号，例如：\n\`1,3,5\` 或 \`all\`\n（可空格跟上游序号，如 \`1,3,5 2\`）`, MAIN_MENU);
        return new Response("OK");
      }
      const r = await batchToggleNodes(env, action, arg === "all" ? "all" : arg, upIdx);
      if (!r.ok) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, `❌ ${r.msg}`, MAIN_MENU);
      } else {
        const hostPreview = r.affected.slice(0, 3).map(h => h.slice(0, 30)).join("\n");
        await sendMenu(ADMIN_BOT_TOKEN, chatId,
          `${action === "off" ? "🔴【批量禁用完成】" : "🟢【批量启用完成】"}\n\n• ${action === "off" ? "禁用" : "启用"}: ${r.done} 个\n• ${action === "off" ? "已禁用跳过" : "未禁用跳过"}: ${r.skipped} 个\n${hostPreview ? `\n${hostPreview}${r.affected.length > 3 ? "\n..." : ""}` : ""}\n\n买家订阅将${action === "off" ? "不再下发这些节点。" : "恢复这些节点。"}`,
          MAIN_MENU);
      }
      return new Response("OK");
    }

    // /check 无参数
    if (state("check_input")) {
      const target = text.trim();
      await env.SUB_STORE.delete("admin_action_state");
      if (!target) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 输入无效，请输入 UID 或 ChatID", MAIN_MENU);
        return new Response("OK");
      }
      let targetUid = target;
      let userDataStr = await env.SUB_STORE.get(`user_${targetUid}`);
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
        await sendMenu(ADMIN_BOT_TOKEN, chatId, `❌ 数据库未找到 UID/ChatID: ${target}`, MAIN_MENU);
      } else {
        const u = JSON.parse(userDataStr);
        const { remainDays, stateDesc } = userSummary(u, targetUid);
        const origin = new URL(request.url).origin;
        const upStatus = u.upstreamUrl ? `🎯 已指定:\n${u.upstreamUrl.slice(0, 50)}` : "🔄 自动分配";
        await sendMenu(ADMIN_BOT_TOKEN, chatId,
          `📊 【用户档案: ${targetUid}】\n• 状态: ${stateDesc}\n• 剩余: ${Math.max(0, remainDays)} 天\n• 到期: ${new Date(u.expiry).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })}\n• ChatID: ${u.chatId || "-"}\n${u.note ? `• 备注: ${u.note}\n` : ""}• 上游: ${upStatus}\n• 短链: ${origin}/s/${targetUid}`,
          {
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
          });
      }
      return new Response("OK");
    }

    // /addurl /setup 无参数
    if (state("addurl")) {
      const url = text.trim();
      await env.SUB_STORE.delete("admin_action_state");
      if (!url.startsWith("http")) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 链接必须以 http/https 开头", MAIN_MENU);
      } else {
        const r = await addUpstream(env, url, `上游${(await getUpstreamPool(env)).length + 1}`);
        await sendMenu(ADMIN_BOT_TOKEN, chatId, r.ok ? `✅ ${r.msg}${r.isDefault ? "（已设为默认）" : ""}` : `❌ ${r.msg}`, MAIN_MENU);
      }
      return new Response("OK");
    }

    // /delurl 无参数
    if (state("delurl")) {
      const idx = parseInt(text.trim()) - 1;
      await env.SUB_STORE.delete("admin_action_state");
      const r = await removeUpstream(env, idx);
      await sendMenu(ADMIN_BOT_TOKEN, chatId, r.ok ? `✅ ${r.msg}` : `❌ ${r.msg}`, MAIN_MENU);
      return new Response("OK");
    }

    // /setdef 无参数
    if (state("setdef")) {
      const idx = parseInt(text.trim()) - 1;
      await env.SUB_STORE.delete("admin_action_state");
      const r = await setDefaultUpstream(env, idx);
      await sendMenu(ADMIN_BOT_TOKEN, chatId, r.ok ? `✅ ${r.msg}` : `❌ ${r.msg}`, MAIN_MENU);
      return new Response("OK");
    }

    // /noteurl 无参数
    if (state("noteurl")) {
      const parts = text.trim().split(/\s+/);
      const idx = parseInt(parts[0]) - 1;
      const note = parts.slice(1).join(" ");
      const pool = await getUpstreamPool(env);
      await env.SUB_STORE.delete("admin_action_state");
      if (isNaN(idx) || idx < 0 || idx >= pool.length || !note) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 格式：序号 备注\n例如：1 日本节点", MAIN_MENU);
      } else {
        pool[idx].note = note;
        await saveUpstreamPool(env, pool);
        await sendMenu(ADMIN_BOT_TOKEN, chatId, `✅ 已设置备注: ${note}`, MAIN_MENU);
      }
      return new Response("OK");
    }

    // /service 无参数
    if (state("service")) {
      const contact = text.trim();
      await env.SUB_STORE.delete("admin_action_state");
      if (!contact) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 输入无效，请输入客服联系方式（如 @用户名 或 https://t.me/用户名）", MAIN_MENU);
      } else {
        await env.SUB_STORE.put("service_contact", contact);
        await sendMenu(ADMIN_BOT_TOKEN, chatId,
          `✅ 【客服已设置】\n\n客服联系方式: ${contact}\n\n买家在前台 Bot 点【📞 联系客服】即可一键联系！`,
          MAIN_MENU);
      }
      return new Response("OK");
    }

    // ===== 菜单按钮处理 =====
    if (text === "➕ 手动开卡") {
      await sendMenu(ADMIN_BOT_TOKEN, chatId, "➕ 【手动开卡】\n请选择开通时长：", daysBtns("newuser_days"));
      return new Response("OK");
    }

    if (text === "🎯 分配上游") {
      await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "assign_uid", chatId }));
      await sendMenu(ADMIN_BOT_TOKEN, chatId, "🎯 【分配上游】\n请输入要分配的用户 UID：", CANCEL_BTN);
      return new Response("OK");
    }

    // /assign 命令
    // /assign 无参数 → 交互引导输入 UID
    if (text === "/assign") {
      await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "assign_uid", chatId }));
      await sendMenu(ADMIN_BOT_TOKEN, chatId, "🎯 【分配上游】\n请输入要分配的用户 UID：", CANCEL_BTN);
      return new Response("OK");
    }

    if (text.startsWith("/assign ")) {
      const parts = text.replace("/assign ", "").trim().split(/\s+/);
      const targetUid = parts[0];
      const upArg = parts[1];
      const userDataStr = await env.SUB_STORE.get(`user_${targetUid}`);
      if (!userDataStr) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, `❌ 用户 UID:${targetUid} 不存在`, MAIN_MENU);
        return new Response("OK");
      }
      const u = JSON.parse(userDataStr);
      if (upArg === "auto") {
        delete u.upstreamUrl;
        await env.SUB_STORE.put(`user_${targetUid}`, JSON.stringify(u));
        await clearUserCache(env, targetUid);
        await sendMenu(ADMIN_BOT_TOKEN, chatId, `✅ 用户 [${targetUid}] 已恢复自动分配上游！`, MAIN_MENU);
        return new Response("OK");
      }
      const upIdx = parseInt(upArg) - 1;
      const pool = await getUpstreamPool(env);
      if (isNaN(upIdx) || upIdx < 0 || upIdx >= pool.length) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 上游序号无效", MAIN_MENU);
        return new Response("OK");
      }
      const up = pool[upIdx];
      u.upstreamUrl = up.url;
      await env.SUB_STORE.put(`user_${targetUid}`, JSON.stringify(u));
      await clearUserCache(env, targetUid);
      await sendMenu(ADMIN_BOT_TOKEN, chatId, `✅ 已为用户 [${targetUid}] 分配专属上游！\n\n📡 ${up.note || "上游" + (upIdx + 1)}\n${up.url}`, MAIN_MENU);
      return new Response("OK");
    }

    if (text === "🔎 搜索用户") {
      await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "search_user", chatId }));
      await sendMenu(ADMIN_BOT_TOKEN, chatId, "🔎 【搜索用户】\n请输入关键词（按备注/套餐/UID 搜索）：\n例如：VIP、月卡、1234", CANCEL_BTN);
      return new Response("OK");
    }

    if (text === "📊 用户统计") {
      const userKeys = await listAllKeys(env, "user_", 10000);
      let active = 0, expired = 0, disabled = 0;
      const expiringSoon = [];
      const now = Date.now();
      for (const k of userKeys) {
        const u = JSON.parse(await env.SUB_STORE.get(k));
        if (u.status === "disabled") disabled++;
        else if (now > u.expiry) expired++;
        else {
          active++;
          if (Math.ceil((u.expiry - now) / 86400000) <= 7) expiringSoon.push(k.replace("user_", ""));
        }
      }
      await sendMenu(ADMIN_BOT_TOKEN, chatId,
        `📊 【用户统计】\n\n` +
        `👥 用户总数: ${userKeys.length}\n` +
        `🟢 正常: ${active}\n` +
        `⏳ 已过期: ${expired}\n` +
        `🔴 已禁用: ${disabled}\n` +
        `⚠️ 7天内到期: ${expiringSoon.length} 人`,
        MAIN_MENU);
      return new Response("OK");
    }

    if (text === "⏳ 即将到期") {
      const now = Date.now();
      const expiring = [];
      for (const k of await listAllKeys(env, "user_", 10000)) {
        const u = JSON.parse(await env.SUB_STORE.get(k));
        if (u.status !== "active") continue;
        const remainDays = Math.ceil((u.expiry - now) / 86400000);
        if (remainDays <= 7 && remainDays > 0) expiring.push({ uid: k.replace("user_", ""), remainDays, chatId: u.chatId });
      }
      expiring.sort((a, b) => a.remainDays - b.remainDays);
      if (expiring.length === 0) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "🎉 7天内没有即将到期的用户", MAIN_MENU);
      } else {
        let msg = `⏳ 【即将到期用户】(7天内)\n\n`;
        for (const e of expiring.slice(0, 20)) msg += `• UID:${e.uid} | 剩 ${e.remainDays} 天 | ChatID:${e.chatId || "-"}\n`;
        if (expiring.length > 20) msg += `\n...还有 ${expiring.length - 20} 个`;
        await sendMenu(ADMIN_BOT_TOKEN, chatId, msg, MAIN_MENU);
      }
      return new Response("OK");
    }

    if (text === "💬 私信用户") {
      await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "msg_uid", chatId }));
      await sendMenu(ADMIN_BOT_TOKEN, chatId, "💬 【私信用户】\n请输入要私信的用户 UID：", CANCEL_BTN);
      return new Response("OK");
    }

    if (text === "⏱️ 调整时长") {
      await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "adjust_uid", chatId }));
      await sendMenu(ADMIN_BOT_TOKEN, chatId, "⏱️ 【调整时长】\n请输入要调整的用户 UID：", CANCEL_BTN);
      return new Response("OK");
    }

    if (text === "📤 导出名单") {
      const userKeys = await listAllKeys(env, "user_", 10000);
      if (userKeys.length === 0) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "📭 当前没有任何用户", MAIN_MENU);
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
        const chunkSize = 30;
        for (let i = 0; i < lines.length; i += chunkSize) {
          await sendText(ADMIN_BOT_TOKEN, chatId, "```\n" + lines.slice(i, i + chunkSize).join("\n") + "\n```");
        }
        await sendMenu(ADMIN_BOT_TOKEN, chatId, `📤 【导出完成】\n共 ${userKeys.length} 位用户，已分块发送`, MAIN_MENU);
      }
      return new Response("OK");
    }

    if (text === "📝 用户备注") {
      await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "note_uid", chatId }));
      await sendMenu(ADMIN_BOT_TOKEN, chatId, "📝 【用户备注】\n请输入要备注的用户 UID：", CANCEL_BTN);
      return new Response("OK");
    }

    if (text === "📋 用户列表") {
      const allUsers = (await listAllKeys(env, "user_", 10000)).map(k => k.replace("user_", ""));
      if (allUsers.length === 0) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "📭 当前没有任何用户", MAIN_MENU);
        return new Response("OK");
      }
      const totalPages = Math.max(1, Math.ceil(allUsers.length / 5));
      let listText = `👥 【用户列表】 (第 1/${totalPages} 页)\n\n`;
      const rows = [];
      for (const uid of allUsers.slice(0, 5)) {
        const u = JSON.parse(await env.SUB_STORE.get(`user_${uid}`));
        const remainDays = Math.ceil((u.expiry - Date.now()) / 86400000);
        const state = u.status === "disabled" ? "🔴" : (remainDays <= 0 ? "⏳" : "🟢");
        listText += `${state} UID:${uid} | 剩 ${Math.max(0, remainDays)} 天${u.note ? ` | 📝${u.note.slice(0, 10)}` : ""}\n`;
        rows.push([
          { text: `📋 ${uid}`, callback_data: `check_${uid}` },
          { text: u.status === "disabled" ? "🟢 启用" : "🔴 禁用", callback_data: `${u.status === "disabled" ? "enable" : "disable"}_${uid}` },
          { text: "🗑️ 删除", callback_data: `del_${uid}` }
        ]);
      }
      if (totalPages > 1) rows.push([{ text: "下一页 ▶️", callback_data: "ulist_2" }]);
      await tg(ADMIN_BOT_TOKEN, "sendMessage", {
        chat_id: chatId, text: listText, reply_markup: { inline_keyboard: rows }
      });
      return new Response("OK");
    }

    if (text === "🔍 查找用户") {
      await sendMenu(ADMIN_BOT_TOKEN, chatId, "🔍 【查找用户】\n请输入 UID 查询，格式：\n`/check UID`", MAIN_MENU);
      return new Response("OK");
    }

    if (text === "📦 订单管理") {
      await sendMenu(ADMIN_BOT_TOKEN, chatId, "📦 【订单管理】\n请选择查看：", {
        keyboard: [
          [{ text: "⏳ 待审核订单" }, { text: "📋 已处理订单" }],
          [{ text: "🧾 收款流水" }],
          [{ text: "🏠 返回主菜单" }]
        ],
        resize_keyboard: true,
        persistent: true
      });
      return new Response("OK");
    }

    if (text === "🧾 收款流水") {
      const recs = [];
      for (const k of await listAllKeys(env, "record_", 5000)) recs.push(JSON.parse(await env.SUB_STORE.get(k)));
      recs.sort((a, b) => (b.time || 0) - (a.time || 0));
      let totalPrice = 0;
      for (const r of recs) {
        const priceNum = extractAmount(r.price);
        if (!isNaN(priceNum)) totalPrice += priceNum;
      }
      let msg = `🧾 【收款流水】 (${recs.length} 笔)\n\n`;
      for (const r of recs.slice(0, 15)) {
        msg += `• ${r.orderId || "—"} (${r.type === "renew" ? "续费" : "新购"}${r.via === "card" ? "·卡密" : ""})\n  ${r.plan || ""} ${r.price || ""}\n  ${new Date(r.time).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}\n`;
      }
      if (totalPrice > 0) msg += `\n💰 流水金额合计: ${totalPrice} 元`;
      await sendMenu(ADMIN_BOT_TOKEN, chatId, msg, MAIN_MENU);
      return new Response("OK");
    }

    // 待审核订单列表（带处理按钮，每页 8 条）
    if (text === "⏳ 待审核订单") {
      return await sendPendingOrders(env, chatId, 1);
    }

    if (text === "📋 已处理订单") {
      const procKeys = await listAllKeys(env, "processed_", 2000);
      if (procKeys.length === 0) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "📭 暂无已处理订单记录", MAIN_MENU);
      } else {
        let ordersText = `📋 【已处理订单】 (最近 ${Math.min(procKeys.length, 20)} 条)\n\n`;
        for (const k of procKeys.slice(-20)) {
          const order = JSON.parse(await env.SUB_STORE.get(k));
          ordersText += `• 买家 ChatID: ${order.chatId}\n  ${new Date(order.time).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}\n`;
        }
        await sendMenu(ADMIN_BOT_TOKEN, chatId, ordersText, MAIN_MENU);
      }
      return new Response("OK");
    }

    if (text === "⚙️ 系统设置") {
      await sendMenu(ADMIN_BOT_TOKEN, chatId, "⚙️ 【系统设置】\n请选择要设置的项目：", {
        keyboard: [
          [{ text: "🔗 上游池管理" }, { text: "📦 套餐管理" }],
          [{ text: "💳 支付方式" }, { text: "📢 发布公告" }],
          [{ text: "💰 设置价格" }, { text: "📅 设置时长" }],
          [{ text: "📞 设置客服" }, { text: "🏠 返回主菜单" }]
        ],
        resize_keyboard: true,
        persistent: true
      });
      return new Response("OK");
    }

    // ===== 支付方式管理 =====
    if (text === "💳 支付方式") {
      const wechat = await getPayQrs(env, "wechat");
      const alipay = await getPayQrs(env, "alipay");
      const usdt = await getUsdtInfo(env);
      const rate = await getUsdtRate(env);
      await sendMenu(ADMIN_BOT_TOKEN, chatId,
        `💳 【支付方式】\n\n` +
        `📱 微信: ${wechat.length > 0 ? `已配置 ${wechat.length} 张收款码 🟢` : "未配置 🔴"}\n` +
        `🧧 支付宝: ${alipay.length > 0 ? `已配置 ${alipay.length} 张收款码 🟢` : "未配置 🔴"}\n` +
        `🪙 USDT: ${usdt ? `已配置 ${usdt.address.slice(0, 8)}... (${usdt.network}) 🟢` : "未配置 🔴"}\n` +
        `💱 USDT 汇率: 1 USDT = ¥${rate}\n\n` +
        `买家购买时可选择已配置的支付方式。`,
        {
          keyboard: [
            [{ text: "📱 配置微信收款码" }, { text: "🧧 配置支付宝收款码" }],
            [{ text: "🪙 配置 USDT 地址" }, { text: "💱 设置 USDT 汇率" }],
            [{ text: "📋 查看/删除已配置" }],
            [{ text: "🏠 返回主菜单" }]
          ],
          resize_keyboard: true,
          persistent: true
        });
      return new Response("OK");
    }

    if (text === "💱 设置 USDT 汇率") {
      const rate = await getUsdtRate(env);
      await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "usdt_rate", chatId }));
      await sendMenu(ADMIN_BOT_TOKEN, chatId,
        `💱 【设置 USDT 汇率】\n当前: 1 USDT = ¥${rate}\n\n请输入 1 USDT 兑多少人民币：\n例如：\`7.2\`（表示 1 U = 7.2 元）`,
        CANCEL_BTN);
      return new Response("OK");
    }

    if (text === "📱 配置微信收款码") {
      await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "setqr_wechat", chatId }));
      await sendMenu(ADMIN_BOT_TOKEN, chatId,
        `📱 【配置微信收款码】\n请发送微信收款码图片（可多张，全部发完发送 /done 完成）：`,
        { keyboard: [[{ text: "✅ 完成上传" }], [{ text: "🏠 返回主菜单" }]], resize_keyboard: true, persistent: true });
      return new Response("OK");
    }

    if (text === "🧧 配置支付宝收款码") {
      await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "setqr_alipay", chatId }));
      await sendMenu(ADMIN_BOT_TOKEN, chatId,
        `🧧 【配置支付宝收款码】\n请发送支付宝收款码图片（可多张，全部发完发送 /done 完成）：`,
        { keyboard: [[{ text: "✅ 完成上传" }], [{ text: "🏠 返回主菜单" }]], resize_keyboard: true, persistent: true });
      return new Response("OK");
    }

    if (text === "🪙 配置 USDT 地址") {
      const current = await getUsdtInfo(env);
      await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "usdt_address", chatId }));
      await sendMenu(ADMIN_BOT_TOKEN, chatId,
        `🪙 【配置 USDT 地址】\n${current ? `当前: ${current.address} (${current.network})\n\n` : ""}请发送：地址 网络\n例如：\`TXYZ1234...  TRC20\`\n（网络可留空，默认 TRC20）`,
        CANCEL_BTN);
      return new Response("OK");
    }

    if (text === "📋 查看/删除已配置") {
      const wechat = await getPayQrs(env, "wechat");
      const alipay = await getPayQrs(env, "alipay");
      const usdt = await getUsdtInfo(env);
      let msg = `💳 【已配置的支付方式】\n\n`;
      msg += `📱 微信 (${wechat.length} 张)：\n`;
      wechat.forEach((q, i) => { msg += `  ${i + 1}. ${q.addedAt ? new Date(q.addedAt).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" }) : "-"}\n`; });
      msg += `🧧 支付宝 (${alipay.length} 张)：\n`;
      alipay.forEach((q, i) => { msg += `  ${i + 1}. ${q.addedAt ? new Date(q.addedAt).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" }) : "-"}\n`; });
      msg += `🪙 USDT: ${usdt ? usdt.address + " (" + usdt.network + ")" : "未配置"}\n\n`;
      msg += `删除：回复「删微信 序号」/「删支付宝 序号」\n清空 USDT：回复「清空USDT」`;
      await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "pay_manage", chatId }));
      await sendMenu(ADMIN_BOT_TOKEN, chatId, msg, CANCEL_BTN);
      return new Response("OK");
    }

    // ===== 套餐管理入口 =====
    if (text === "📦 套餐管理" || text === "/plans") {
      await showPlanManage(env, chatId);
      return new Response("OK");
    }

    if (text === "📞 设置客服") {
      const current = await env.SUB_STORE.get("service_contact") || "未设置";
      await sendMenu(ADMIN_BOT_TOKEN, chatId,
        `📞 【设置客服】\n\n当前客服: ${current}\n\n请发送命令设置客服联系方式：\n\n格式：\`/service @客服用户名\`\n或：\`/service https://t.me/客服用户名\``,
        MAIN_MENU);
      return new Response("OK");
    }

    // /service 无参数 → 交互引导
    if (text === "/service") {
      await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "service", chatId }));
      await sendMenu(ADMIN_BOT_TOKEN, chatId,
        `📞 【设置客服】\n当前: ${(await env.SUB_STORE.get("service_contact")) || "未设置"}\n\n请发送客服联系方式（@用户名 或 https://t.me/用户名）：`,
        CANCEL_BTN);
      return new Response("OK");
    }

    if (text.startsWith("/service ")) {
      const contact = text.replace("/service ", "").trim();
      if (!contact) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 格式：/service @客服用户名", MAIN_MENU);
      } else {
        await env.SUB_STORE.put("service_contact", contact);
        await sendMenu(ADMIN_BOT_TOKEN, chatId,
          `✅ 【客服已设置】\n\n客服联系方式: ${contact}\n\n买家在前台 Bot 点【📞 联系客服】即可一键联系！`,
          MAIN_MENU);
      }
      return new Response("OK");
    }

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
      await sendMenu(ADMIN_BOT_TOKEN, chatId, msg, MAIN_MENU);
      return new Response("OK");
    }

    // /addurl 无参数 → 交互引导
    if (text === "/addurl") {
      await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "addurl", chatId }));
      await sendMenu(ADMIN_BOT_TOKEN, chatId, "🔗 【添加】\n请发送上游订阅链接（http/https 开头）：", CANCEL_BTN);
      return new Response("OK");
    }

    if (text.startsWith("/addurl ")) {
      const url = text.replace("/addurl ", "").trim();
      if (!url.startsWith("http")) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 链接必须以 http/https 开头", MAIN_MENU);
      } else {
        const r = await addUpstream(env, url, `上游${(await getUpstreamPool(env)).length + 1}`);
        await sendMenu(ADMIN_BOT_TOKEN, chatId, r.ok ? `✅ ${r.msg}${r.isDefault ? "（已设为默认）" : ""}` : `❌ ${r.msg}`, MAIN_MENU);
      }
      return new Response("OK");
    }

    // /delurl /setdef /noteurl 无参数 → 显示上游列表 + 交互输入序号
    if (text === "/delurl" || text === "/setdef" || text === "/noteurl") {
      const pool = await getUpstreamPool(env);
      if (pool.length === 0) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "📭 当前没有上游，先用 /addurl 添加", MAIN_MENU);
        return new Response("OK");
      }
      let msg = "🔗 【上游列表】\n";
      pool.forEach((u, i) => { msg += `${i + 1}. ${u.note || "上游" + (i + 1)} ${u.isDefault ? "⭐默认" : ""}\n`; });
      if (text === "/delurl") {
        await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "delurl", chatId }));
        msg += `\n请发送要删除的序号：`;
      } else if (text === "/setdef") {
        await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "setdef", chatId }));
        msg += `\n请发送要设为默认的序号：`;
      } else {
        await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "noteurl", chatId }));
        msg += `\n请发送：序号 备注\n例如：1 日本节点`;
      }
      await sendMenu(ADMIN_BOT_TOKEN, chatId, msg, CANCEL_BTN);
      return new Response("OK");
    }

    if (text.startsWith("/delurl ")) {
      const idx = parseInt(text.replace("/delurl ", "").trim()) - 1;
      const r = await removeUpstream(env, idx);
      await sendMenu(ADMIN_BOT_TOKEN, chatId, r.ok ? `✅ ${r.msg}` : `❌ ${r.msg}`, MAIN_MENU);
      return new Response("OK");
    }

    if (text.startsWith("/setdef ")) {
      const idx = parseInt(text.replace("/setdef ", "").trim()) - 1;
      const r = await setDefaultUpstream(env, idx);
      await sendMenu(ADMIN_BOT_TOKEN, chatId, r.ok ? `✅ ${r.msg}` : `❌ ${r.msg}`, MAIN_MENU);
      return new Response("OK");
    }

    if (text.startsWith("/noteurl ")) {
      const parts = text.replace("/noteurl ", "").trim().split(/\s+/);
      const idx = parseInt(parts[0]) - 1;
      const note = parts.slice(1).join(" ");
      const pool = await getUpstreamPool(env);
      if (isNaN(idx) || idx < 0 || idx >= pool.length || !note) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 格式：/noteurl 序号 备注", MAIN_MENU);
      } else {
        pool[idx].note = note;
        await saveUpstreamPool(env, pool);
        await sendMenu(ADMIN_BOT_TOKEN, chatId, `✅ 已设置备注: ${note}`, MAIN_MENU);
      }
      return new Response("OK");
    }

    // 节点管理
    if (text === "/nodes" || text.startsWith("/nodes ")) {
      const pool = await getUpstreamPool(env);
      const arg = text.startsWith("/nodes ") ? parseInt(text.replace("/nodes ", "").trim()) : 1;
      const idx = (arg && arg >= 1) ? arg - 1 : 0;
      if (idx >= pool.length) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, `❌ 上游序号无效（共 ${pool.length} 个）`, MAIN_MENU);
        return new Response("OK");
      }
      const up = pool[idx];
      await sendText(ADMIN_BOT_TOKEN, chatId, `⏳ 正在拉取上游 #${idx + 1} 的节点，请稍候…`);
      const result = await fetchUpstreamNodes(env, up.url);
      if (!result.ok) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, `❌ 上游 #${idx + 1} 拉取失败（${up.url.slice(0, 50)}）`, MAIN_MENU);
        return new Response("OK");
      }
      if (result.nodes.length === 0) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "📭 该上游没有解析到节点", MAIN_MENU);
        return new Response("OK");
      }
      const blacklist = await getNodeBlacklist(env);
      let msg = `📡 【节点列表】上游 #${idx + 1}\n${up.note || ""}\n共 ${result.nodes.length} 个节点\n\n`;
      result.nodes.slice(0, 15).forEach((n, i) => {
        const disabled = blacklist.includes(n.host);
        msg += `${disabled ? "🔴" : "🟢"} ${i + 1}. ${(n.name || n.host).slice(0, 30)}\n   ${n.host}\n`;
      });
      msg += `\n**命令：**\n` +
        `/nodeoff 1,3,5 - 批量禁用节点\n` +
        `/nodeon 1,3,5 - 批量启用节点\n` +
        `/nodeoff all - 禁用全部\n` +
        `/nodeon all - 启用全部\n` +
        `/nodelist - 查看禁用列表`;
      await sendMenu(ADMIN_BOT_TOKEN, chatId, msg, MAIN_MENU);
      return new Response("OK");
    }

    // 批量禁用/启用节点
    const nodeToggleHandler = async (action) => {
      const parts = text.replace(action === "off" ? "/nodeoff " : "/nodeon ", "").trim().split(/\s+/);
      const arg = parts[0];
      const upIdx = (parts[1] ? parseInt(parts[1]) : 1) - 1;
      if (arg !== "all" && !/^[\d,\s]+$/.test(arg)) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, `❌ 格式：/${action === "off" ? "nodeoff" : "nodeon"} 1,3,5 或 /${action === "off" ? "nodeoff" : "nodeon"} all [上游序号=1]`, MAIN_MENU);
        return;
      }
      if (isNaN(upIdx) || upIdx < 0) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, `❌ 上游序号无效\n格式：/${action === "off" ? "nodeoff" : "nodeon"} 1,3,5 [上游序号=1]`, MAIN_MENU);
        return;
      }
      const r = await batchToggleNodes(env, action, arg === "all" ? "all" : arg, upIdx);
      if (!r.ok) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, `❌ ${r.msg}`, MAIN_MENU);
      } else {
        const hostPreview = r.affected.slice(0, 3).map(h => h.slice(0, 30)).join("\n");
        await sendMenu(ADMIN_BOT_TOKEN, chatId,
          `${action === "off" ? "🔴【批量禁用完成】" : "🟢【批量启用完成】"}\n\n• ${action === "off" ? "禁用" : "启用"}: ${r.done} 个\n• ${action === "off" ? "已禁用跳过" : "未禁用跳过"}: ${r.skipped} 个\n${hostPreview ? `\n${hostPreview}${r.affected.length > 3 ? "\n..." : ""}` : ""}\n\n买家订阅将${action === "off" ? "不再下发这些节点。" : "恢复这些节点。"}`,
          MAIN_MENU);
      }
    };

    // /nodeoff /nodeon 无参数 → 交互引导输入
    if (text === "/nodeoff" || text === "/nodeon") {
      const action = text === "/nodeoff" ? "off" : "on";
      await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "node_toggle", action, chatId }));
      await sendMenu(ADMIN_BOT_TOKEN, chatId,
        `${action === "off" ? "🔴【禁用节点】" : "🟢【启用节点】"}\n请发送节点序号（可先 /nodes 查看）：\n\n例：\`1,3,5\` 或 \`all\`\n（可空格跟上游序号，如 \`1,3,5 2\`）`,
        CANCEL_BTN);
      return new Response("OK");
    }

    if (text.startsWith("/nodeoff ")) {
      await nodeToggleHandler("off");
      return new Response("OK");
    }
    if (text.startsWith("/nodeon ")) {
      await nodeToggleHandler("on");
      return new Response("OK");
    }

    if (text === "/nodelist") {
      const blacklist = await getNodeBlacklist(env);
      if (blacklist.length === 0) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "📭 当前没有禁用的节点", MAIN_MENU);
      } else {
        let msg = `🔴 【节点禁用列表】(${blacklist.length})\n\n`;
        blacklist.forEach((h, i) => { msg += `${i + 1}. ${h}\n`; });
        msg += `\n使用 /nodeon 1,2,3 或 /nodeon all 恢复节点`;
        await sendMenu(ADMIN_BOT_TOKEN, chatId, msg, MAIN_MENU);
      }
      return new Response("OK");
    }

    if (text === "/merge" || text.startsWith("/merge ")) {
      const arg = text === "/merge" ? "" : text.replace("/merge ", "").trim().toLowerCase();
      const current = await isMergeMode(env) ? "on" : "off";
      if (arg === "on") {
        await env.SUB_STORE.put("merge_mode", "on");
        await clearAllCache(env);
        await sendMenu(ADMIN_BOT_TOKEN, chatId,
          `🔄 【合并模式已开启】\n\n所有买家订阅将合并上游池中全部节点的线路！\n（已清除缓存，立即生效）`,
          MAIN_MENU);
      } else if (arg === "off") {
        await env.SUB_STORE.put("merge_mode", "off");
        await clearAllCache(env);
        await sendMenu(ADMIN_BOT_TOKEN, chatId, `➡️ 【合并模式已关闭】\n\n恢复为按用户分配单个上游。`, MAIN_MENU);
      } else {
        let preview = "";
        if (current === "on") {
          preview = `\n\n📡 当前合并后节点数: ${(await fetchAllUpstreamsMerged(env)).length}`;
        } else {
          preview = `\n\n💡 开启后买家将获得所有上游的节点（自动去重）`;
        }
        await sendMenu(ADMIN_BOT_TOKEN, chatId,
          `🔄 【合并模式】\n\n当前状态: ${current === "on" ? "✅ 开启" : "⭕ 关闭"}${preview}\n\n命令：\n/merge on - 开启合并\n/merge off - 关闭合并`,
          MAIN_MENU);
      }
      return new Response("OK");
    }

    if (text === "📢 发布公告") {
      await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "notice", chatId }));
      await sendMenu(ADMIN_BOT_TOKEN, chatId, "📢 【发布公告】\n请发送公告内容：\n\n（公告会显示在前台 Bot 的 /start 中）", CANCEL_BTN);
      return new Response("OK");
    }

    if (text === "💰 设置价格") {
      await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "set_price", chatId }));
      await sendMenu(ADMIN_BOT_TOKEN, chatId,
        `💰 【设置套餐价格】\n当前: ${(await env.SUB_STORE.get("price_info")) || "未设置"}\n\n请直接发送价格内容（如：30元/月）：`,
        CANCEL_BTN);
      return new Response("OK");
    }

    if (text === "📅 设置时长") {
      await sendMenu(ADMIN_BOT_TOKEN, chatId,
        `📅 【设置默认时长】\n当前: ${(await env.SUB_STORE.get("default_days")) || DEFAULT_DAYS} 天\n\n请选择或输入：`,
        daysBtns("setdays"));
      return new Response("OK");
    }

    if (text === "🎫 卡密管理") {
      await sendMenu(ADMIN_BOT_TOKEN, chatId,
        `🎫 【卡密管理】\n\n📋 卡密列表 = 查看全部卡密，可直接禁用/删除/查详情\n🔍 查询卡密 = 输入完整/部分卡密码查单张\n\n批量生成请用左侧命令菜单：\n\`/gencard 数量 天数 价格\`\n\`/gencp 数量 天数 折扣 备注\``,
        {
          keyboard: [
            [{ text: "📋 卡密列表" }, { text: "📋 卡密统计" }],
            [{ text: "🔍 查询卡密" }, { text: "🗑️ 清理已用卡密" }],
            [{ text: "🗑️ 删除未使用卡密" }],
            [{ text: "🏠 返回主菜单" }]
          ],
          resize_keyboard: true,
          persistent: true
        });
      return new Response("OK");
    }

    if (text === "📋 卡密列表") {
      await sendCardList(env, chatId, 1);
      return new Response("OK");
    }

    if (text === "🎁 生成优惠券") {
      await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "gencoupon", chatId }));
      await sendMenu(ADMIN_BOT_TOKEN, chatId,
        `🎁 【生成优惠券】\n请直接发送命令：\n\n\`/gencp 数量 天数 折扣 备注\`\n\n例：\`/gencp 5 30 80 八折月卡\`\n（折扣=优惠后价格百分比，80=8折）`,
        CANCEL_BTN);
      return new Response("OK");
    }

    if (text.startsWith("/gencp")) {
      const parts = text.split(/\s+/);
      const count = parseInt(parts[1]);
      if (!count || count <= 0 || count > 200) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 格式：/gencp 数量 天数 折扣 备注\n例：/gencp 5 30 80 八折月卡", MAIN_MENU);
        return new Response("OK");
      }
      const daysArg = parts[2];
      const days = daysArg === undefined ? 30 : parseInt(daysArg);
      if (!days || days <= 0 || days > 3650) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 天数无效（1-3650）\n例：/gencp 5 30 80 八折月卡", MAIN_MENU);
        return new Response("OK");
      }
      const discountArg = parts[3];
      const discount = discountArg === undefined ? 100 : parseInt(discountArg);
      if (!discount || discount <= 0 || discount > 100) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 折扣无效（1-100，80=8折）\n例：/gencp 5 30 80 八折月卡", MAIN_MENU);
        return new Response("OK");
      }
      const note = parts.slice(4).join(" ") || `${days} 天优惠券`;
      const coupons = await genCoupons(env, count, days, discount, note);
      await sendCodes(ADMIN_BOT_TOKEN, chatId, coupons.map(c => c.code));
      await sendMenu(ADMIN_BOT_TOKEN, chatId,
        `🎁 【优惠券已生成】\n\n• 数量: ${count}\n• 时长: ${days} 天\n• 折扣: ${discount}%\n• 备注: ${note}\n\n买家在 @${getStoreBotUsername()} 点【🎁 优惠券】即可兑换！`,
        MAIN_MENU);
      return new Response("OK");
    }

    if (text === "➕ 生成卡密" || text === "/gencard") {
      await sendMenu(ADMIN_BOT_TOKEN, chatId, `➕ 【生成卡密】\n请选择生成数量：`, {
        inline_keyboard: [
          [{ text: "5 张", callback_data: "gencard_qty_5" }, { text: "10 张", callback_data: "gencard_qty_10" }],
          [{ text: "20 张", callback_data: "gencard_qty_20" }, { text: "50 张", callback_data: "gencard_qty_50" }],
          [{ text: "✏️ 自定义数量", callback_data: "gencard_qty_custom" }],
          [{ text: "❌ 取消", callback_data: "cancel_action" }]
        ]
      });
      return new Response("OK");
    }

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
      await sendMenu(ADMIN_BOT_TOKEN, chatId,
        `📊 【卡密统计】\n\n• 总卡密: ${total}\n• 未使用: ${unused} 🟢\n• 已使用: ${used} 🔵\n• 已禁用: ${disabled} 🔴`,
        MAIN_MENU);
      return new Response("OK");
    }

    if (text === "🔍 查询卡密") {
      await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "card_query", chatId }));
      await sendMenu(ADMIN_BOT_TOKEN, chatId, "🔍 【查询卡密】\n请输入卡密（或完整/部分卡密）：", CANCEL_BTN);
      return new Response("OK");
    }

    if (text === "🗑️ 清理已用卡密") {
      let deleted = 0;
      for (const k of await listAllKeys(env, "card_", 10000)) {
        const c = JSON.parse(await env.SUB_STORE.get(k));
        if (c.status === "used") {
          await env.SUB_STORE.delete(k);
          deleted++;
        }
      }
      await sendMenu(ADMIN_BOT_TOKEN, chatId, `🗑️ 【清理完成】\n已删除 ${deleted} 张已使用卡密`, MAIN_MENU);
      return new Response("OK");
    }

    if (text === "🗑️ 删除未使用卡密") {
      let deleted = 0;
      for (const k of await listAllKeys(env, "card_", 10000)) {
        const c = JSON.parse(await env.SUB_STORE.get(k));
        if (c.status === "unused") {
          await env.SUB_STORE.delete(k);
          deleted++;
        }
      }
      await sendMenu(ADMIN_BOT_TOKEN, chatId, `🗑️ 【删除完成】\n已删除 ${deleted} 张未使用卡密\n（已使用/已禁用的保留）`, MAIN_MENU);
      return new Response("OK");
    }

    if (text.startsWith("/gencard")) {
      const parts = text.split(/\s+/);
      const count = parseInt(parts[1]);
      if (!count || count <= 0 || count > 200) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 格式错误！\n请使用：`/gencard 数量 天数 价格`\n例：`/gencard 10 30 30元`", MAIN_MENU);
        return new Response("OK");
      }
      let days = parseInt(parts[2]);
      if (!days || days <= 0 || days > 3650) days = parseInt(await env.SUB_STORE.get("default_days")) || DEFAULT_DAYS;
      const price = parts[3] || (await env.SUB_STORE.get("price_info")) || "";
      const cards = await genCards(env, count, days, `${days} 天套餐`, price);
      await sendCodes(ADMIN_BOT_TOKEN, chatId, cards.map(c => c.code), `🎫 【卡密生成成功】\n\n• 数量: ${count}\n• 时长: ${days} 天\n• 价格: ${price || "未设置"}\n\n`);
      await sendMenu(ADMIN_BOT_TOKEN, chatId,
        `✅ 已生成 ${count} 张卡密，请复制上方卡密发放给买家。\n\n买家在 @${getStoreBotUsername()} 发送「🎫 兑换卡密」即可自助兑换！`,
        MAIN_MENU);
      return new Response("OK");
    }

    if (text === "💰 分销系统") {
      await sendMenu(ADMIN_BOT_TOKEN, chatId, "💰 【分销系统】\n管理你的分销网络：", {
        keyboard: [
          [{ text: "📋 分销商列表" }, { text: "➕ 创建分销商" }],
          [{ text: "📈 设置佣金比例" }, { text: "🔗 推广链接" }],
          [{ text: "🗑️ 删除分销商" }],
          [{ text: "🏠 返回主菜单" }]
        ],
        resize_keyboard: true,
        persistent: true
      });
      return new Response("OK");
    }

    if (text === "📈 设置佣金比例") {
      await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "comm_pct", chatId }));
      await sendMenu(ADMIN_BOT_TOKEN, chatId,
        "📈 【设置佣金比例】\n请输入佣金百分比（如 20 = 20%）：\n\n当前默认佣金比例: " + ((await env.SUB_STORE.get("comm_rate")) || "10") + "%",
        CANCEL_BTN);
      return new Response("OK");
    }

    if (text === "🔗 推广链接") {
      const resellerKeys = await listAllKeys(env, "reseller_", 2000);
      if (resellerKeys.length === 0) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "📭 请先创建分销商", MAIN_MENU);
      } else {
        let msg = `🔗 【分销商推广链接】\n\n`;
        for (const k of resellerKeys) {
          const r = JSON.parse(await env.SUB_STORE.get(k));
          msg += `• ${r.name}\n  推广码: \`${r.code}\`\n  链接: ${getStoreOrigin(request)}/r/${r.code}\n\n`;
        }
        msg += `买家打开链接会自动关联该分销商。`;
        await sendMenu(ADMIN_BOT_TOKEN, chatId, msg, MAIN_MENU);
      }
      return new Response("OK");
    }

    if (text === "📋 分销商列表") {
      const resellerKeys = await listAllKeys(env, "reseller_", 2000);
      if (resellerKeys.length === 0) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "📭 当前还没有分销商\n点击【➕ 创建分销商】添加", MAIN_MENU);
      } else {
        let textMsg = `💰 【分销商列表】\n\n`;
        for (const k of resellerKeys) {
          const r = JSON.parse(await env.SUB_STORE.get(k));
          textMsg += `• ${r.name || k.replace("reseller_", "")}\n  邀请码: \`${r.code}\`\n  推广点击: ${r.clicks || 0}\n  成交订单: ${r.orders || 0}\n  佣金: ${r.commission || 0} 元\n`;
        }
        await sendMenu(ADMIN_BOT_TOKEN, chatId, textMsg, MAIN_MENU);
      }
      return new Response("OK");
    }

    if (text === "🗑️ 删除分销商") {
      const resellerKeys = await listAllKeys(env, "reseller_", 2000);
      if (resellerKeys.length === 0) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "📭 当前还没有分销商", MAIN_MENU);
      } else {
        const btns = [];
        for (const k of resellerKeys) {
          const r = JSON.parse(await env.SUB_STORE.get(k));
          btns.push([{ text: `${r.name} (${r.code})`, callback_data: `delreseller_${k.replace("reseller_", "")}` }]);
        }
        btns.push([{ text: "❌ 取消", callback_data: "cancel_action" }]);
        await sendMenu(ADMIN_BOT_TOKEN, chatId, `🗑️ 【删除分销商】\n请选择要删除的分销商：`, { inline_keyboard: btns });
      }
      return new Response("OK");
    }

    if (text === "➕ 创建分销商") {
      await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "reseller_name", chatId }));
      await sendMenu(ADMIN_BOT_TOKEN, chatId, "➕ 【创建分销商】\n请输入分销商名称（如：张三）：", CANCEL_BTN);
      return new Response("OK");
    }

    if (text === "📊 系统概览") {
      await sendMenu(ADMIN_BOT_TOKEN, chatId, await buildOverview(env), MAIN_MENU);
      return new Response("OK");
    }

    if (text === "📣 群发通知") {
      await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "broadcast", chatId }));
      await sendMenu(ADMIN_BOT_TOKEN, chatId, "📣 【群发通知】\n请发送要群发的消息内容：\n\n（将发送给所有已开通用户）", CANCEL_BTN);
      return new Response("OK");
    }

    if (text === "📜 操作日志") {
      const logs = await env.SUB_STORE.list({ prefix: "log_", limit: 100 });
      if (logs.keys.length === 0) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "📭 暂无操作日志", MAIN_MENU);
      } else {
        const entries = [];
        for (const k of logs.keys) entries.push(JSON.parse(await env.SUB_STORE.get(k.name)));
        entries.sort((a, b) => (b.time || 0) - (a.time || 0));
        let msg = `📜 【操作日志】(最近 ${entries.length} 条)\n\n`;
        for (const e of entries.slice(0, 20)) {
          msg += `• ${e.action}: ${e.detail}\n  ${new Date(e.time).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}\n`;
        }
        await sendMenu(ADMIN_BOT_TOKEN, chatId, msg, MAIN_MENU);
      }
      return new Response("OK");
    }

    // 帮助说明
    if (text === "❓ 帮助说明" || text === "/start") {
      const helpMsg = `👑 【AETHERIA 管理中枢使用指南】\n\n` +
                      `**👥 用户管理**\n- 用户列表：查看所有用户及状态\n- 查找用户：/check UID 或 /check ChatID\n- 用户统计：活跃/过期/禁用分布\n- 即将到期：7天内到期用户\n- 手动开卡：为指定 ChatID 开通\n- 调整时长：给用户加/减天数\n- 用户备注：给用户打标签\n- 私信用户：一对一给用户发消息\n- 导出名单：导出全部用户信息\n\n` +
                      `**📦 套餐管理**\n- 增删改/启停套餐，买家只看到在售套餐\n- 按钮操作，无需记命令\n\n` +
                      `**🎫 卡密管理**\n- 生成卡密：/gencard 数量 天数 价格\n- 买家自助兑换，无需审核\n- 卡密统计/查询/清理\n\n` +
                      `**📦 订单管理**\n- 待审核：查看付款凭证\n- 已处理：处理记录\n- 收款流水：订单流水与金额统计\n- 发货：凭证下方点【确认到账】\n\n` +
                      `**⚙️ 系统设置**\n- 上游池：/addurl 链接 添加（可无限加）\n- 管理上游：/listurl /delurl /setdef\n- 合并节点：/merge on 合并所有上游节点\n- 节点管理：/nodes 查看 /nodeoff 禁用 /nodeon 启用\n- 支付方式：💳 支付方式 配置微信/支付宝/USDT\n- 价格/时长/客服：⚙️ 系统设置 内按钮化\n- 公告：📢 发布公告\n\n` +
                      `**📣 群发通知**\n- 给所有用户发消息\n\n` +
                      `**💰 分销系统**\n- 创建分销商（自动生成推广链接）\n- 设置佣金比例\n- 查看推广点击与佣金\n- 删除分销商\n\n` +
                      `**📊 系统概览**\n- 用户/订单/卡密/套餐/流水全统计\n\n` +
                      `**⏰ 到期提醒（自动）**\n- 到期前 ${REMINDER_DAYS.join("/")} 天自动通知`;
      await sendMenu(ADMIN_BOT_TOKEN, chatId, helpMsg, MAIN_MENU);
      return new Response("OK");
    }

    if (text === "🏠 返回主菜单") {
      await sendMenu(ADMIN_BOT_TOKEN, chatId, "🏠 已返回主菜单，请选择操作：", MAIN_MENU);
      return new Response("OK");
    }

    if (text === "/cancel") {
      await env.SUB_STORE.delete("admin_action_state");
      try { await delMsg(ADMIN_BOT_TOKEN, chatId, msg.message_id); } catch (e) {}
      await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 已取消当前操作", MAIN_MENU);
      return new Response("OK");
    }

    // 收款码托管：等待状态下直接收图
    if (msg.photo && (actionState && ["setqr_wechat", "setqr_alipay"].includes(actionState.mode))) {
      const adminFileId = msg.photo[msg.photo.length - 1].file_id;
      const currentMode = actionState.mode;
      if (!text.includes("/done")) {
        await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: currentMode, chatId }));
      } else {
        await env.SUB_STORE.delete("admin_action_state");
      }
      try { await delMsg(ADMIN_BOT_TOKEN, chatId, msg.message_id); } catch (e) {}

      try {
        const storeFileId = await convertQRForStoreBot(adminFileId);
        if (storeFileId) {
          const doneText = text.includes("/done") ? "\n（已完成上传）" : "";
          const continueText = text.includes("/done") ? "" : "\n\n可继续上传下一张，或发送 /done 完成";
          let listLen = 0;
          let replyMsg;
          if (currentMode === "setqr_wechat") {
            const list = await addPayQr(env, "wechat", storeFileId);
            listLen = list.length;
            replyMsg = `✅ 【微信收款码已收录】第 ${listLen} 张！\n\n当前共 ${listLen} 张微信收款码${doneText}${continueText}`;
          } else {
            const list = await addPayQr(env, "alipay", storeFileId);
            listLen = list.length;
            replyMsg = `✅ 【支付宝收款码已收录】第 ${listLen} 张！\n\n当前共 ${listLen} 张支付宝收款码${doneText}${continueText}`;
          }
          await sendMenu(ADMIN_BOT_TOKEN, chatId, replyMsg,
            text.includes("/done") ? MAIN_MENU : { keyboard: [[{ text: "✅ 完成上传" }], [{ text: "🏠 返回主菜单" }]], resize_keyboard: true, persistent: true });
        } else {
          await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 收款码转换失败，请重新上传。", MAIN_MENU);
        }
      } catch (e) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 收款码处理异常，请稍后重试。", MAIN_MENU);
      }
      return new Response("OK");
    }

    if (text === "✅ 完成上传" || text === "/done") {
      await env.SUB_STORE.delete("admin_action_state");
      const wechat = await getPayQrs(env, "wechat");
      const alipay = await getPayQrs(env, "alipay");
      const usdt = await getUsdtInfo(env);
      await sendMenu(ADMIN_BOT_TOKEN, chatId,
        `✅ 【支付方式配置完成】\n\n📱 微信: ${wechat.length} 张收款码\n🧧 支付宝: ${alipay.length} 张收款码\n🪙 USDT: ${usdt ? "已配置" : "未配置"}\n\n买家购买时可选已配置的支付方式。`,
        MAIN_MENU);
      return new Response("OK");
    }

    // /setup 无参数 → 交互引导输入链接
    if (text === "/setup") {
      await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "addurl", chatId }));
      await sendMenu(ADMIN_BOT_TOKEN, chatId, "🔗 【设置上游】\n请发送上游订阅链接（http/https 开头）：", CANCEL_BTN);
      return new Response("OK");
    }

    if (text.startsWith("/setup ")) {
      const upstream = text.replace("/setup ", "").trim();
      const r = await addUpstream(env, upstream, "手动设置");
      if (r.ok) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, `✅ ${r.msg}${r.isDefault ? "（已设为默认）" : ""}\n\n如需管理多个上游，请用 /addurl 添加更多。`, MAIN_MENU);
      } else {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, `❌ ${r.msg}\n如需更换请使用 /addurl 添加`, MAIN_MENU);
      }
      return new Response("OK");
    }

    // /price /days 无参数 → 复用现有交互
    if (text === "/price") {
      await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "set_price", chatId }));
      await sendMenu(ADMIN_BOT_TOKEN, chatId,
        `💰 【设置套餐价格】\n当前: ${(await env.SUB_STORE.get("price_info")) || "未设置"}\n\n请直接发送价格内容（如：30元/月）：`,
        CANCEL_BTN);
      return new Response("OK");
    }
    if (text === "/days") {
      await sendMenu(ADMIN_BOT_TOKEN, chatId,
        `📅 【设置默认时长】\n当前: ${(await env.SUB_STORE.get("default_days")) || DEFAULT_DAYS} 天\n\n请选择或输入天数：`,
        daysBtns("setdays"));
      return new Response("OK");
    }

    if (text.startsWith("/price ")) {
      const price = text.replace("/price ", "").trim();
      await env.SUB_STORE.put("price_info", price);
      await sendMenu(ADMIN_BOT_TOKEN, chatId, `✅ 【套餐价格已设置】\n${price}`, MAIN_MENU);
      return new Response("OK");
    }

    if (text.startsWith("/days ")) {
      const days = parseInt(text.replace("/days ", "").trim());
      if (isNaN(days) || days <= 0) {
        await sendMenu(ADMIN_BOT_TOKEN, chatId, "❌ 格式错误，请使用：`/days 30`", MAIN_MENU);
      } else {
        await env.SUB_STORE.put("default_days", days.toString());
        await sendMenu(ADMIN_BOT_TOKEN, chatId, `✅ 【默认时长已设置】\n${days} 天`, MAIN_MENU);
      }
      return new Response("OK");
    }

    // /sc 快捷用户命令
    if (text === "/sc" || text.startsWith("/sc ")) {
      const scArg = text === "/sc" ? "" : text.replace("/sc ", "").trim();
      if (scArg) {
        let scUid = scArg;
        let scDataStr = await env.SUB_STORE.get(`user_${scUid}`);
        if (!scDataStr && /^\d+$/.test(scArg)) {
          const uidByChat = await findUidByChatId(env, parseInt(scArg));
          if (uidByChat) {
            scUid = uidByChat;
            scDataStr = await env.SUB_STORE.get(`user_${uidByChat}`);
          }
        }
        if (!scDataStr) {
          await sendMenu(ADMIN_BOT_TOKEN, chatId, `❌ 未找到用户 UID/ChatID: ${scArg}`, MAIN_MENU);
        } else {
          const su = JSON.parse(scDataStr);
          const { remainDays, stateDesc } = userSummary(su, scUid);
          const upStatus = su.upstreamUrl ? "🎯 已指定" : "🔄 自动分配";
          await sendMenu(ADMIN_BOT_TOKEN, chatId,
            `📊 【用户: ${scUid}】\n• 状态: ${stateDesc}\n• 剩余: ${Math.max(0, remainDays)} 天\n• 到期: ${new Date(su.expiry).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })}\n• ChatID: ${su.chatId || "-"}\n${su.note ? `• 备注: ${su.note}\n` : ""}• 上游: ${upStatus}\n\n请选择操作：`,
            opsButtons(scUid));
        }
      } else {
        const scKeys = await listAllKeys(env, "user_", 5000);
        if (scKeys.length === 0) {
          await sendMenu(ADMIN_BOT_TOKEN, chatId, "📭 当前没有任何用户", MAIN_MENU);
        } else {
          const rows = [];
          let row = [];
          for (const k of scKeys) {
            row.push({ text: k.replace("user_", ""), callback_data: `ops_${k.replace("user_", "")}` });
            if (row.length === 3) { rows.push(row); row = []; }
          }
          if (row.length) rows.push(row);
          await sendMenu(ADMIN_BOT_TOKEN, chatId, `👥 【用户列表】\n点击 UID 进入操作面板：\n\n（共 ${scKeys.length} 位用户）`, { inline_keyboard: rows });
        }
      }
      return new Response("OK");
    }

    // /check 查用户
    // /check 无参数 → 交互引导输入 UID/ChatID
    if (text === "/check") {
      await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "check_input", chatId }));
      await sendMenu(ADMIN_BOT_TOKEN, chatId, "📊 【查用户】\n请输入 UID 或 ChatID：", CANCEL_BTN);
      return new Response("OK");
    }

    if (text.startsWith("/check ")) {
      const target = text.replace("/check ", "").trim();
      let targetUid = target;
      let userDataStr = await env.SUB_STORE.get(`user_${targetUid}`);
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
        await sendMenu(ADMIN_BOT_TOKEN, chatId, `❌ 数据库未找到 UID/ChatID: ${target}`, MAIN_MENU);
      } else {
        const u = JSON.parse(userDataStr);
        const { remainDays, stateDesc } = userSummary(u, targetUid);
        const origin = new URL(request.url).origin;
        const upStatus = u.upstreamUrl ? `🎯 已指定:\n${u.upstreamUrl.slice(0, 50)}` : "🔄 自动分配";
        await sendMenu(ADMIN_BOT_TOKEN, chatId,
          `📊 【用户档案: ${targetUid}】\n• 状态: ${stateDesc}\n• 剩余: ${Math.max(0, remainDays)} 天\n• 到期: ${new Date(u.expiry).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })}\n• ChatID: ${u.chatId || "-"}\n${u.note ? `• 备注: ${u.note}\n` : ""}• 上游: ${upStatus}\n• 短链: ${origin}/s/${targetUid}`,
          {
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
          });
      }
      return new Response("OK");
    }

    // 默认兜底：识别未支持的斜杠命令，其余引导到菜单
    if (actionState && actionState.mode) {
      await sendMenu(ADMIN_BOT_TOKEN, chatId,
        `⚠️ 当前有未完成的操作，请按引导继续输入，或点击下方按钮取消：`,
        { inline_keyboard: [[{ text: "❌ 取消当前操作", callback_data: "cancel_action" }]] });
      return new Response("OK");
    }
    if (text.startsWith("/")) {
      await sendMenu(ADMIN_BOT_TOKEN, chatId,
        `❓ 未识别的命令 \`${text.split(" ")[0]}\`\n\n发送 /start 查看帮助，或使用下方菜单操作。`,
        MAIN_MENU);
    } else {
      await sendMenu(ADMIN_BOT_TOKEN, chatId, "收到指令。如需帮助请点击下方菜单或发送 /start", MAIN_MENU);
    }
    return new Response("OK");
  } catch (err) {
    return new Response("OK");
  }
}

// ==================== 模块 0: Webhook 自注册 ====================
async function handleWebhookSetup(request, env) {
  try {
    if (SETUP_KEY) {
      const url = new URL(request.url);
      if (url.searchParams.get("key") !== SETUP_KEY) {
        return new Response("Forbidden: invalid setup key", { status: 403 });
      }
    }
    const origin = new URL(request.url).origin;
    const storeWebhook = `${origin}/bot/store`;
    const adminWebhook = `${origin}/bot/admin`;
    const secret = env.WEBHOOK_SECRET || "";
    const secretParam = secret ? `&secret_token=${encodeURIComponent(secret)}` : "";

    const storeJson = await (await fetch(`${TG_API}${STORE_BOT_TOKEN}/setWebhook?url=${encodeURIComponent(storeWebhook)}${secretParam}`)).json();
    const adminJson = await (await fetch(`${TG_API}${ADMIN_BOT_TOKEN}/setWebhook?url=${encodeURIComponent(adminWebhook)}${secretParam}`)).json();

    const storeCommands = [
      { command: "start", description: "🏠 开始 / 公告" },
      { command: "buy", description: "🛒 购买套餐" }
    ];
    const adminCommands = [
      { command: "start", description: "🏠 主菜单" },
      { command: "sc", description: "⚡ 快捷管理用户 /sc [UID]" },
      { command: "check", description: "📊 查用户 /check UID" },
      { command: "plans", description: "📦 套餐管理" },
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
      { command: "cancel", description: "❌ 取消当前操作" }
    ];

    const setStoreCmds = await tg(STORE_BOT_TOKEN, "setMyCommands", { commands: storeCommands });
    const setAdminCmds = await tg(ADMIN_BOT_TOKEN, "setMyCommands", { commands: adminCommands });

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

// ==================== 主入口 ====================
export default {
  async fetch(request, env, ctx) {
    loadConfig(env);
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith("/s/")) {
      const uid = path.replace("/s/", "").trim();
      if (!uid) return new Response("Error: Invalid UID", { status: 400 });
      return await handleBuyerPortal(uid, request, env);
    }
    if (path.startsWith("/renew/")) {
      const uid = path.replace("/renew/", "").trim();
      if (!uid) return new Response("Error: Invalid UID", { status: 400 });
      return await handleRenewPage(uid, request, env);
    }
    if (path.startsWith("/r/")) {
      const code = path.replace("/r/", "").trim().toUpperCase();
      if (!code) return new Response("Error: Invalid Code", { status: 400 });
      return await handleResellerLanding(code, request, env);
    }
    if (path === "/bot/store" && request.method === "POST") {
      if (env.WEBHOOK_SECRET && request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      return await handleStoreBot(request, env);
    }
    if (path === "/bot/admin" && request.method === "POST") {
      if (env.WEBHOOK_SECRET && request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      return await handleAdminBot(request, env);
    }
    if (path === "/setup-webhooks") {
      return await handleWebhookSetup(request, env);
    }

    return new Response("AETHERIA Ultra Console is Active.", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  },

  async scheduled(event, env, ctx) {
    loadConfig(env);
    try {
      await checkExpiringSubscriptions(env);
      if (event && event.cron === "0 0 * * *") {
        await sendDailyReport(env);
      }
    } catch (err) {}
  }
};
