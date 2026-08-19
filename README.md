# AETHERIA 双 Bot 商业级自动化订阅分销系统

> 🚀 零服务器成本 · Cloudflare Workers + KV · 双 Telegram Bot（前台售卖 + 后台管理）

基于 Cloudflare Workers 的**零成本代理订阅分销系统**，内置完整商业闭环：多套餐选购 → 收款码 → 人工/卡密审核 → 自动开通 → 到期提醒 → 续费 → 分销裂变。

---

## 📋 目录

- [✨ 核心功能](#-核心功能)
- [🏗️ 架构](#️-架构)
- [🚀 部署教程（三种方式任选）](#-部署教程三种方式任选)
  - [方式一：Wrangler CLI（推荐）](#方式一wrangler-cli推荐)
  - [方式二：Cloudflare Dashboard 网页](#方式二cloudflare-dashboard-网页)
  - [方式三：GitHub Actions 自动部署](#方式三github-actions-自动部署)
- [⚙️ 初始化配置](#️-初始化配置)
- [📚 常用命令速查](#-常用命令速查)
- [💬 买家使用指南](#-买家使用指南)
- [⚡ 免人工核验方案（全自动发货）](#-免人工核验方案全自动发货)
- [🔒 安全说明](#-安全说明)
- [❓ 常见问题](#-常见问题)
- [📦 文件结构](#-文件结构)
- [⚖️ 免责声明](#️-免责声明)

---

## ✨ 核心功能

### 🛍️ 前台售卖 Bot（买家端）
- **多套餐选购**：月卡/季卡/年卡自定义配置，买家点按钮自选
- **多收款码支付**：支持多张收款码随机轮换，分散收款压力
- **卡密兑换**：`MB-XXXX-XXXX-XXXX` 格式，买家自助兑换，无需人工审核
- **优惠券兑换**：`CP-XXXX-XXXX-XXXX` 格式，营销活动利器
- **订阅自助查询**：随时查看自己的到期时间/状态/订阅链接
- **智能 FAQ**：常见问题自动解答，减少客服压力
- **联系客服**：可配置的客服一键直达

### 👑 后台管理 Bot（管理端）
- **👥 用户管理**：列表/查找/搜索/统计/开卡/调时长/备注/私信/导出/即将到期
- **🎯 上游分配**：给指定用户分配专属上游线路
- **🎫 卡密管理**：按钮式批量生成/统计/查询/清理
- **🎁 优惠券管理**：批量生成折扣优惠券
- **📦 订单管理**：待审/已处理/收款流水/金额统计
- **🔗 上游池管理**：无限添加上游，按用户分配或合并全部节点
- **📡 节点管理**：查看/单个/批量禁用节点（支持 `1,3,5` 或 `all`）
- **⚙️ 系统设置**：上游/多收款码/价格/时长/公告/客服（全按钮化）
- **📣 群发通知 / 💰 分销系统 / 📊 系统概览 / 📜 操作日志**
- **↩️ 全操作可撤销**：发货/开卡/调时长/删除用户 24h 内可撤销
- **⏰ 自动到期提醒**：Cron 定时，到期前 3/1/0 天自动通知
- **📊 每日运营日报**：每天自动推送昨日经营统计

### 🖥️ 买家网页门户
- 玻璃拟态精美控制台
- 公告横幅 + 到期提醒横幅
- 有效期使用进度条
- 一键导入 Clash / 扫码导入 / 复制订阅
- 使用教程折叠面板 / 提前续费入口 / 客服直达

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

- **存储**：Cloudflare KV（用户/订单/卡密/优惠券/上游池/黑名单/公告/配置）
- **定时任务**：Cron 到期提醒 + 每日日报
- **双 Bot 隔离**：前台 Bot 拥有买家聊天访问权，管理 Bot 仅接收管理指令

---

## 🚀 部署教程（三种方式任选）

### 准备阶段（所有方式通用）

1. **注册 Cloudflare 账号**：https://dash.cloudflare.com （免费）
2. **创建两个 Telegram Bot**：找 [@BotFather](https://t.me/BotFather) → `/newbot` 创建
   - 前台售卖 Bot（给买家用的）
   - 后台管理 Bot（你自己用的）
   - 记下两个 Bot 的 Token（形如 `123456789:AAxxxxxxxxxxxxxxxx`）
3. **获取你的 Telegram 数字 ID**：找 [@userinfobot](https://t.me/userinfobot) → 发送任意消息
4. **准备上游订阅链接**（节点来源，可后续添加）

---

### 方式一：Wrangler CLI（推荐）

适合本地开发部署，功能最全。

#### 1. 安装依赖

```bash
# 安装 Node.js (https://nodejs.org 下载 LTS 版)
node --version

# 安装 Wrangler CLI
npm install -g wrangler

# 验证
wrangler --version
```

#### 2. 获取代码

```bash
git clone https://github.com/k52784742-blip/aetheria-sub-master.git
cd aetheria-sub-master
```

#### 3. 配置

```bash
# 复制配置模板
cp wrangler.toml.example wrangler.toml
cp .dev.vars.example .dev.vars
```

编辑 `wrangler.toml`：

```toml
name = "aetheria-sub-master"
main = "worker.js"
compatibility_date = "2026-08-19"
workers_dev = false

[vars]
ADMIN_BOT_TOKEN = "你的管理Bot Token"
STORE_BOT_TOKEN = "你的前台Bot Token"
ADMIN_ID = "你的Telegram数字ID"
DEFAULT_UPSTREAM_URL = "你的默认上游链接"
# 可选：Webhook 安全校验密钥
# WEBHOOK_SECRET = "随机字符串"

# 自定义域名路由（可选，没有就删掉这段）
routes = [
  { pattern = "你的域名.com", custom_domain = true }
]

[triggers]
crons = ["0 0 * * *", "0 8 * * *"]

[[kv_namespaces]]
binding = "SUB_STORE"
id = "YOUR_KV_NAMESPACE_ID"
```

#### 4. 登录并创建 KV

```bash
# 登录 Cloudflare
wrangler login

# 创建 KV Namespace（记下返回的 ID 填入 wrangler.toml）
wrangler kv namespace create SUB_STORE
```

#### 5. 部署

```bash
wrangler deploy
```

#### 6. 注册 Webhook

浏览器访问（将域名替换为你的）：

```
https://你的域名/setup-webhooks
```

看到 `"ok": true` 表示两个 Bot 的 Webhook 注册成功。

---

### 方式二：Cloudflare Dashboard 网页

适合不想装命令行的用户，全程网页操作。

#### 1. 获取代码文件

在 GitHub 仓库页面：https://github.com/k52784742-blip/aetheria-sub-master

点击 **Code → Download ZIP**，解压后找到 `worker.js` 和 `wrangler.toml.example`。

#### 2. 创建 Worker

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 左侧菜单 → **Workers & Pages** → **创建** → **创建 Worker**
3. 输入名称 `aetheria-sub-master` → **部署**
4. 点击 **编辑代码** → 全选删除默认代码 → 粘贴 `worker.js` 全部内容 → **保存并部署**

#### 3. 创建 KV Namespace

1. 左侧菜单 → **Workers & Pages** → **KV** → **创建命名空间**
2. 名称填 `SUB_STORE` → 创建
3. 记下 **Namespace ID**

#### 4. 绑定 KV

1. 回到 Worker 页面 → **设置** → **变量**
2. **KV 命名空间绑定** → 添加绑定
3. 变量名填 `SUB_STORE` → 选择刚创建的命名空间 → 保存

#### 5. 配置环境变量

在 Worker **设置 → 变量 → 环境变量**：

| 变量名 | 值 |
|--------|-----|
| `ADMIN_BOT_TOKEN` | 你的管理Bot Token |
| `STORE_BOT_TOKEN` | 你的前台Bot Token |
| `ADMIN_ID` | 你的Telegram数字ID |
| `DEFAULT_UPSTREAM_URL` | 你的默认上游链接 |
| `WEBHOOK_SECRET` | 可选，随机字符串 |

点击 **保存** 后，**重新部署** Worker 使配置生效。

#### 6. 配置 Cron 触发器

Worker **设置 → 触发器 → Cron 触发器** → 添加：

```
0 0 * * *
0 8 * * *
```

#### 7. 配置自定义域名（可选）

Worker **设置 → 域和路由 → 添加** → 绑定你的域名。

#### 8. 注册 Webhook

浏览器访问：`https://你的worker域名/setup-webhooks`

---

### 方式三：GitHub Actions 自动部署

适合长期维护，推送代码自动部署。

#### 1. 准备 Secrets

在 GitHub 仓库 → **Settings → Secrets and variables → Actions**，添加：

| Secret 名 | 值 |
|-----------|-----|
| `CF_API_TOKEN` | Cloudflare API Token（Workers 编辑权限） |
| `CF_ACCOUNT_ID` | Cloudflare 账户 ID |
| `ADMIN_BOT_TOKEN` | 你的管理Bot Token |
| `STORE_BOT_TOKEN` | 你的前台Bot Token |
| `ADMIN_ID` | 你的Telegram数字ID |
| `DEFAULT_UPSTREAM_URL` | 你的默认上游链接 |
| `KV_NAMESPACE_ID` | 你的 KV Namespace ID |

> 获取 Cloudflare API Token：Dashboard → 我的个人资料 → API 令牌 → 创建令牌 → 选「编辑 Cloudflare Workers」模板

#### 2. 创建部署工作流

在仓库创建 `.github/workflows/deploy.yml`：

```yaml
name: Deploy Worker

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install Wrangler
        run: npm install -g wrangler

      - name: Write wrangler.toml
        run: |
          cat > wrangler.toml <<EOF
          name = "aetheria-sub-master"
          main = "worker.js"
          compatibility_date = "2026-08-19"
          workers_dev = false

          [vars]
          ADMIN_BOT_TOKEN = "${{ secrets.ADMIN_BOT_TOKEN }}"
          STORE_BOT_TOKEN = "${{ secrets.STORE_BOT_TOKEN }}"
          ADMIN_ID = "${{ secrets.ADMIN_ID }}"
          DEFAULT_UPSTREAM_URL = "${{ secrets.DEFAULT_UPSTREAM_URL }}"

          [triggers]
          crons = ["0 0 * * *", "0 8 * * *"]

          [[kv_namespaces]]
          binding = "SUB_STORE"
          id = "${{ secrets.KV_NAMESPACE_ID }}"
          EOF

      - name: Deploy
        run: wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CF_ACCOUNT_ID }}
```

#### 3. 推送触发部署

之后每次 `git push` 到 main 分支都会自动部署。

---

## ⚙️ 初始化配置

部署完成后，在**管理 Bot** 中进行初始化：

### 1. 添加上游
```
/addurl 你的订阅链接
```
可无限添加，`/merge on` 可合并所有上游节点。

### 2. 设置收款码
```
/setqr → 发送收款码图片（可传多张）→ /done 完成
```

### 3. 生成卡密（可选）
```
/gencard 10 30 30元
```

### 4. 发布公告（可选）
```
⚙️ 系统设置 → 📢 发布公告
```

### 5. 设置客服（可选）
```
/service @你的客服用户名
```

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
| `/gencp 数量 天数 折扣 备注` | 生成优惠券 |
| `/check UID或ChatID` | 查用户 |
| `/assign UID 上游序号` | 给用户分配专属上游 |
| `/qrlist` / `/qrdel 序号` | 查看/删除收款码 |
| `/service @客服用户名` | 设置客服 |

### 前台 Bot（买家用）
| 命令 | 功能 |
|------|------|
| `/start` | 开始（显示公告+套餐） |
| 点「🎫 兑换卡密」+ 输入卡密 | 自助兑换 |
| 点「🎁 优惠券」+ 输入券码 | 优惠券兑换 |

---

## 💬 买家使用指南

### 购买流程（人工核验模式）
1. 打开前台 Bot → 点【🛒 购买套餐】
2. 选择套餐（月卡/季卡/年卡）
3. 扫码付款 → 发送转账截图
4. 管理员确认 → 秒开通

### 自助兑换（免人工核验模式）
1. 点【🎫 兑换卡密】→ 输入卡密 → 秒开通
2. 点【🎁 优惠券】→ 输入券码 → 秒开通

### 网页控制台
打开订阅链接 → 查看状态/导入客户端/续费

---

## ⚡ 免人工核验方案（全自动发货）

> 不想每笔订单都人工审核？用**卡密/优惠券**实现 24 小时全自动发货，买家付款后自助开通，你只管收钱。

### 为什么用卡密？

| 对比 | 人工核验 | 卡密自动核验 |
|------|---------|-------------|
| 发货速度 | 需等管理员在线 | **秒开通** |
| 人工成本 | 每单都要看截图 | **零人工** |
| 营业时间 | 受管理员作息限制 | **24 小时无人值守** |
| 防跑单 | 靠人工判断 | **先收款后给码** |

### 方案一：卡密全自动（推荐）

**适用**：社群卖码、代理分销、线下/网店销售

```
1. 管理员生成一批卡密：/gencard 100 30 30元
2. 卡密发放给代理 / 上架网店 / 发到群里售卖
3. 买家拿到卡密 → 打开前台 Bot → 点【🎫 兑换卡密】→ 输入卡密
4. ✅ 系统自动开通订阅，无需任何人审核
```

**操作流程**：
```
管理员：
/gencard 数量 天数 价格      → 批量生成卡密（如 /gencard 100 30 30元）
📋 卡密统计                   → 查看库存/已用/剩余

买家：
点【🎫 兑换卡密】→ 输入 MB-XXXX-XXXX-XXXX → 秒开通
```

### 方案二：优惠券全自动（营销用）

**适用**：活动促销、老客户回馈、代理激励

```
1. 管理员生成优惠券：/gencp 20 30 80 八折月卡
2. 优惠券发给目标用户
3. 买家点【🎁 优惠券】→ 输入券码 → 自动开通
```

### 方案三：混合模式（推荐运营）

```
🔵 线上散客 → 人工核验（收款码+截图审核）
🟢 渠道/代理 → 卡密（先款后码，自动开通）
🟡 活动/回馈 → 优惠券（定向发放）
```

### 卡密最佳实践

1. **先收款后给码**：卡密 = 已付款凭证，务必确认收到钱再发码
2. **批量生成**：一次生成 50-100 张，避免频繁操作
3. **定期统计**：用【📋 卡密统计】查看使用情况
4. **清理已用**：用【🗑️ 清理已用卡密】保持 KV 整洁
5. **渠道分发**：不同代理给不同批次，方便追踪

---

## 🔒 安全说明

- **Token 不硬编码**：通过环境变量/Secrets 注入
- **`.gitignore`**：排除 `wrangler.toml`、`.dev.vars` 等敏感文件
- **Webhook 校验**：可选 `WEBHOOK_SECRET` 防止伪造请求
- **幂等保护**：防重复点击误操作
- **操作可撤销**：误操作 24h 内可恢复
- **Token 隔离**：前台/管理 Bot 的 Token 分离，互不泄露

---

## ❓ 常见问题

**Q: 需要服务器吗？**
A: 不需要！完全运行在 Cloudflare Workers 免费额度上（每天 10 万次请求）。

**Q: 需要域名吗？**
A: 不需要，默认使用 `*.workers.dev` 子域名即可运行。自定义域名可选。

**Q: KV 存储免费吗？**
A: 免费版每天 10 万次读写，1000 个 key，个人使用完全够用。

**Q: 两个 Bot 必须都是 BotFather 创建的吗？**
A: 是的，需要两个独立的 Bot Token。

**Q: 部署后 Bot 没反应？**
A: 检查 Webhook 是否注册成功：访问 `/setup-webhooks` 看返回 `"ok": true`。

**Q: 如何更新代码？**
A: `git pull` 拉取最新 → `wrangler deploy` 重新部署。

---

## 📦 文件结构

```
├── worker.js              主程序（全部逻辑）
├── wrangler.toml          本地部署配置（敏感，已 gitignore）
├── wrangler.toml.example  配置模板（GitHub 共享）
├── .dev.vars.example      本地开发变量模板
├── .gitignore             排除敏感文件
├── README.md              本文档
└── LICENSE                MIT 协议
```

---

## ⚖️ 免责声明

本项目仅供技术学习与研究。请遵守当地法律法规，请勿用于非法用途。使用者需自行承担相关责任。

---

## 📄 License

MIT
