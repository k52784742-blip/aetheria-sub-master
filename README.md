# AETHERIA 双 Bot 商业级自动化分销系统

> 🚀 零服务器成本 · Cloudflare Workers + KV · 双 Telegram Bot（前台售卖 + 后台管理）

基于 Cloudflare Workers 的**零成本代理订阅分销系统**，内置完整商业闭环：多套餐选购 → 收款码 → 人工/卡密审核 → 自动开通 → 到期提醒 → 续费 → 分销裂变。

---

## ✨ 核心功能

### 🛍️ 前台售卖 Bot（买家端）
- **多套餐选购**：月卡/季卡/年卡自定义配置，买家点按钮自选
- **收款码支付**：扫码付款 → 发截图 → 管理员审核 → 秒开通
- **卡密兑换**：`MB-XXXX-XXXX-XXXX` 格式，买家自助兑换，无需人工审核
- **订阅自助查询**：随时查看自己的到期时间/状态/订阅链接
- **联系客服**：可配置的客服一键直达

### 👑 后台管理 Bot（管理端）
- **👥 用户管理**：列表/查找（UID或ChatID）/手动开卡/调整时长/备注/私信/导出/统计/即将到期
- **🎫 卡密管理**：按钮式批量生成/统计/查询/清理
- **📦 订单管理**：待审/已处理/收款流水/金额统计
- **🔗 上游池管理**：无限添加上游，按用户分配或合并全部节点
- **📡 节点管理**：查看/单个禁用/批量禁用（支持 `1,3,5` 或 `all`）
- **⚙️ 系统设置**：上游/收款码/价格/时长/公告/客服（全按钮化）
- **📣 群发通知 / 💰 分销系统 / 📊 系统概览**
- **↩️ 全操作可撤销**：发货/开卡/调时长/删除用户 24h 内可撤销
- **⏰ 自动到期提醒**：Cron 定时，到期前 3/1/0 天自动通知

### 🖥️ 买家网页门户
- 玻璃拟态精美控制台
- 一键导入 Clash / 扫码导入 / 复制订阅
- 使用教程折叠面板
- 到期自动显示续费入口

---

## 🏗️ 架构

```
Cloudflare Workers
├── /s/{uid}          买家订阅门户 + 节点清洗引擎
├── /renew/{uid}      续费工单页
├── /r/{code}         分销推广落地页
├── /bot/store        前台售卖 Bot Webhook
├── /bot/admin        后台管理 Bot Webhook
└── /setup-webhooks   Webhook 自注册
```

- **存储**：Cloudflare KV（用户/订单/卡密/上游池/黑名单/公告/配置）
- **定时任务**：Cron 到期提醒
- **双 Bot 隔离**：前台 Bot 拥有买家聊天访问权，管理 Bot 仅接收管理指令

---

## 🚀 快速部署

### 1. 准备
- [Cloudflare 账号](https://dash.cloudflare.com)（免费）
- 两个 Telegram Bot（[@BotFather](https://t.me/BotFather) 创建）
- 你的 Telegram 数字 ID（[@userinfobot](https://t.me/userinfobot) 获取）

### 2. 配置
```bash
# 复制配置模板
cp wrangler.toml.example wrangler.toml

# 创建 KV Namespace
wrangler kv namespace create SUB_STORE

# 编辑 wrangler.toml，填入：
# - 两个 Bot Token
# - 你的 Telegram ID
# - KV Namespace ID
# - 自定义域名
```

> ⚠️ 推荐用 `wrangler secret put` 设置 Token，避免明文：
> ```bash
> wrangler secret put ADMIN_BOT_TOKEN
> wrangler secret put STORE_BOT_TOKEN
> ```

### 3. 部署
```bash
wrangler deploy
```

### 4. 注册 Webhook
访问 `https://你的域名/setup-webhooks`（一次性自动注册两个 Bot 的 Webhook）

### 5. 初始化
在管理 Bot 中：
- `/addurl 上游链接` 添加上游（可无限）
- 上传收款码图片（系统设置 → 设置收款码）
- `/gencard 10 30 30元` 生成卡密

---

## 📚 常用命令速查

### 管理 Bot
| 命令 | 功能 |
|------|------|
| `/addurl 链接` | 添加上游 |
| `/delurl 序号` / `/setdef 序号` | 删除/设默认上游 |
| `/merge on\|off` | 合并全部上游节点 |
| `/nodes` | 查看节点列表 |
| `/nodeoff 1,3,5` / `/nodeon all` | 批量禁用/启用节点 |
| `/nodelist` | 查看禁用列表 |
| `/gencard 数量 天数 价格` | 生成卡密 |
| `/check UID或ChatID` | 查用户 |
| `/service @客服用户名` | 设置客服 |

### 前台 Bot
| 命令 | 功能 |
|------|------|
| `/start` | 开始（显示公告+套餐） |
| 点「🎫 兑换卡密」+ 输入卡密 | 自助兑换 |

---

## 🔒 安全说明

- **Token 不硬编码**：通过 `wrangler secret` 或环境变量注入
- **`.gitignore`**：排除 `wrangler.toml`、`.dev.vars` 等敏感文件
- **部署模板**：`wrangler.toml.example` 用占位符，可安全共享
- **幂等保护**：防重复点击误操作
- **操作可撤销**：误操作 24h 内可恢复

---

## 📦 文件结构

```
├── worker.js            主程序（全部逻辑）
├── wrangler.toml        本地部署配置（敏感，已 gitignore）
├── wrangler.toml.example 配置模板（GitHub 共享）
├── .dev.vars.example    本地开发变量模板
└── .gitignore
```

---

## ⚖️ 免责声明

本项目仅供技术学习与研究。请遵守当地法律法规，请勿用于非法用途。使用者需自行承担相关责任。

---

## 📄 License

MIT
