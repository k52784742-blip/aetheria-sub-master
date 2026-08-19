# AETHERIA 双 Bot 商业级自动化订阅分销系统

> 🚀 零服务器成本 · Cloudflare Workers + KV · 双 Telegram Bot（前台售卖 + 后台管理）

基于 Cloudflare Workers 的**零成本代理订阅分销系统**，内置完整商业闭环：多套餐选购 → 收款码 → 人工/卡密审核 → 自动开通 → 到期提醒 → 续费 → 分销裂变。

---

## 📋 目录

- [✨ 核心功能](#-核心功能)
- [🏗️ 架构](#️-架构)
- [🚀 部署教程（四种方式任选）](#-部署教程四种方式任选)
  - [📋 配置要求](#-配置要求先看这个)
  - [方式一：Wrangler CLI（保姆级）](#方式一wrangler-cli推荐保姆级教程)
  - [方式二：Cloudflare Dashboard 网页](#方式二cloudflare-dashboard-网页)
  - [方式三：GitHub Actions 自动部署](#方式三github-actions-自动部署)
  - [方式四：VPS 服务器部署](#方式四vps-服务器部署自建服务器方案)
- [⚙️ 初始化配置](#️-初始化配置)
- [📚 常用命令速查](#-常用命令速查)
- [💬 买家使用指南](#-买家使用指南)
- [⚡ 免人工核验方案（全自动发货）](#-免人工核验方案全自动发货)
- [🤖 全自动运营教程（24 小时无人值守）](#-全自动运营教程24-小时无人值守)
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

## 🚀 部署教程（四种方式任选）

### 📋 配置要求（先看这个！）

#### 免费方案（Cloudflare Workers）配置要求

| 项目 | 最低要求 | 说明 |
|------|---------|------|
| **Cloudflare 账号** | 免费版 | 每日 10 万次请求，个人足够 |
| **KV 存储** | 免费版 | 每日 10 万次读写，1000 个 key |
| **Cron 触发器** | 免费版 | 每天 2 次自动提醒 |
| **自定义域名** | 不需要 | 可用 `*.workers.dev` 免费子域名 |
| **Node.js** | v18+ | 仅部署时需要，运行时不需要 |
| **Telegram Bot** | 2 个 | BotFather 免费创建 |

> ✅ **免费方案 = ¥0 成本**，个人/小团队完全够用

#### VPS 服务器方案配置要求

| 项目 | 最低要求 | 推荐配置 |
|------|---------|---------|
| **CPU** | 1 核 | 1 核 |
| **内存** | 512 MB | 1 GB |
| **硬盘** | 10 GB | 20 GB SSD |
| **带宽** | 1 Mbps | 5 Mbps 以上 |
| **系统** | Ubuntu 20.04+ | Ubuntu 22.04 LTS |
| **Node.js** | v18+ | v18/v20 LTS |
| **域名** | 需要 | 建议 `.com` 等常规后缀 |
| **网络** | 海外机房 | 推荐 Vultr/DigitalOcean |

> ⚠️ **VPS 必须能访问 Telegram API**（海外机房），否则 webhook 无法工作

#### 你的电脑配置要求（部署用）

| 项目 | 最低要求 |
|------|---------|
| **系统** | Windows 10 / macOS / Linux 均可 |
| **Node.js** | v18+（下载：https://nodejs.org） |
| **网络** | 能访问 GitHub（下载代码） |

#### 上游订阅链接要求

| 项目 | 说明 |
|------|------|
| **格式** | 支持 Base64 编码的订阅链接（vless/vmess/trojan 等） |
| **访问** | 需要能被 Cloudflare/VPS 访问（不能只内网可用） |
| **数量** | 1 个即可，可后续添加多个 |

---

### 准备阶段（所有方式通用）

1. **注册 Cloudflare 账号**：https://dash.cloudflare.com （免费）
2. **创建两个 Telegram Bot**：找 [@BotFather](https://t.me/BotFather) → `/newbot` 创建
   - 前台售卖 Bot（给买家用的）
   - 后台管理 Bot（你自己用的）
   - 记下两个 Bot 的 Token（形如 `123456789:AAxxxxxxxxxxxxxxxx`）
3. **获取你的 Telegram 数字 ID**：找 [@userinfobot](https://t.me/userinfobot) → 发送任意消息
4. **准备上游订阅链接**（节点来源，可后续添加）

---

### 方式一：Wrangler CLI（推荐，保姆级教程）

适合本地开发部署，功能最全。下面每一步都写到**你照着做就能成功**的程度。

#### 1️⃣ 安装 Node.js（Windows/Mac/Linux）

**Windows 用户：**
1. 打开浏览器访问 https://nodejs.org
2. 点击下载 **LTS 版本**（左边的按钮，比如 v18.x）
3. 双击下载的 `.msi` 文件，一路点"下一步"安装
4. 安装完成后，**重新打开** PowerShell 终端

**验证是否安装成功**（在终端输入）：
```bash
node --version
npm --version
```
> 看到类似 `v18.20.0` 和 `10.7.0` 就成功了。
> 如果提示"不是内部或外部命令"，说明没装好，重装一次。

#### 2️⃣ 安装 Wrangler CLI

在终端输入：
```bash
npm install -g wrangler
```
> 等待出现 `added xxx packages` 就是成功。
> 如果报权限错误（Linux/Mac），前面加 `sudo`：`sudo npm install -g wrangler`

验证：
```bash
wrangler --version
```

#### 3️⃣ 获取项目代码

**方法 A：用 git（推荐）**
```bash
git clone https://github.com/k52784742-blip/aetheria-sub-master.git
cd aetheria-sub-master
```

**方法 B：直接下载 ZIP**
1. 打开 https://github.com/k52784742-blip/aetheria-sub-master
2. 点绿色按钮 **Code** → **Download ZIP**
3. 解压到一个文件夹（比如 `D:\aetheria`）
4. 在解压后的文件夹里打开终端

> 💡 Windows 用户在文件夹地址栏输入 `cmd` 或 `powershell` 回车即可打开终端

#### 4️⃣ 复制配置文件

在项目文件夹的终端里输入：
```bash
# Windows 用户（PowerShell）
copy wrangler.toml.example wrangler.toml
copy .dev.vars.example .dev.vars

# Mac/Linux 用户
cp wrangler.toml.example wrangler.toml
cp .dev.vars.example .dev.vars
```

#### 5️⃣ 编辑配置文件（关键！）

用**记事本**（Windows）或 VS Code 打开 `wrangler.toml`，修改这些内容：

| 配置项 | 填什么 | 去哪找 |
|--------|--------|--------|
| `ADMIN_BOT_TOKEN` | 你的**管理 Bot** Token | 找 @BotFather → `/mybots` → 选管理Bot → API Token |
| `STORE_BOT_TOKEN` | 你的**前台 Bot** Token | 同上，选前台 Bot |
| `ADMIN_ID` | 你的 Telegram 数字 ID | 找 @userinfobot 发任意消息 |
| `DEFAULT_UPSTREAM_URL` | 你的订阅链接 | 你的机场/上游提供的链接 |
| `YOUR_KV_NAMESPACE_ID` | 第 7 步创建后填 | 见下方第 7 步 |

修改后保存（记事本 `Ctrl+S`）。

#### 6️⃣ 登录 Cloudflare

在终端输入：
```bash
wrangler login
```
> 会自动打开浏览器，登录你的 Cloudflare 账号，点 **Allow** 授权。
> 如果浏览器没打开，复制终端里显示的网址手动打开。

#### 7️⃣ 创建 KV 存储空间

```bash
wrangler kv namespace create SUB_STORE
```
> 会返回一串 ID，类似：
> ```
> id = "87ae5157747f4cc1a98509e006787695"
> ```
> **复制这串 ID**，回到 `wrangler.toml`，把 `id = "YOUR_KV_NAMESPACE_ID"` 里的 `YOUR_KV_NAMESPACE_ID` 替换成这串 ID，保存。

#### 8️⃣ 部署上线（核心一步）

```bash
wrangler deploy
```
> 看到类似输出就是成功：
> ```
> Uploaded aetheria-sub-master (3.2 sec)
> Deployed aetheria-sub-master triggers
>   https://你的worker名.你的账号.workers.dev
> ```
> 记下这个 `https://...workers.dev` 网址，后面要用。

#### 9️⃣ 注册 Webhook（最后一步）

打开浏览器，访问：
```
https://你的worker名.你的账号.workers.dev/setup-webhooks
```
> 页面显示：
> ```json
> {
>   "store_bot": { "ok": true },
>   "admin_bot": { "ok": true }
> }
> ```
> 两个 `"ok": true` 就是全部成功！

#### 🔟 开始使用

打开你的**管理 Bot**，发送任意消息，就能看到管理菜单了！
先按"初始化配置"章节完成设置，然后就能开始营业。

#### 常见问题（方式一）

| 问题 | 解决 |
|------|------|
| `wrangler login` 后没反应 | 检查浏览器是否登录了 Cloudflare |
| `wrangler deploy` 报错 | 确认 `wrangler.toml` 的 ID 填对了没 |
| Webhook 显示 false | 确认访问的是 `https://` 不是 `http://` |
| 部署成功但 Bot 没反应 | 重新访问一次 `/setup-webhooks` |

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

### 方式四：VPS 服务器部署（自建服务器方案）

> 适合：已有 VPS 服务器、需要完全掌控、或 Cloudflare 免费额度不够的情况。
> 本方式需要一台 Linux 服务器（推荐 Ubuntu 22.04），成本约 ¥30-50/月。

#### 1. 准备服务器

**购买服务器**（任选一家）：
- 腾讯云/阿里云：国内服务器，需备案
- Vultr / DigitalOcean / Bandwagon：海外服务器，免备案（推荐）

**推荐配置**：1 核 CPU / 1GB 内存 / 20GB 硬盘（最低档即可）

**服务器系统**：选择 **Ubuntu 22.04 LTS**

**登录服务器**（Windows 用户用 PowerShell）：
```bash
ssh root@你的服务器IP
# 输入密码后进入服务器
```

#### 2. 安装 Node.js 环境

在服务器上依次执行：

```bash
# 1. 更新系统
apt update && apt upgrade -y

# 2. 安装 Node.js 18+（用官方源）
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt install -y nodejs

# 3. 验证
node --version
npm --version
```

#### 3. 获取项目代码

```bash
# 安装 git
apt install -y git

# 克隆项目
git clone https://github.com/k52784742-blip/aetheria-sub-master.git
cd aetheria-sub-master
```

#### 4. 配置环境变量

```bash
# 复制配置模板
cp wrangler.toml.example wrangler.toml

# 编辑配置（用 nano 编辑器）
nano wrangler.toml
```

把里面的值改成你的真实信息，然后 `Ctrl+X` → `Y` → 回车 保存。

#### 5. 安装 Node 运行依赖

项目纯 JS 无第三方依赖，但为了用 `node` 直接运行 Worker，需要一个小工具：

```bash
npm init -y
npm install wrangler
```

#### 6. 创建 KV 存储（本地模拟）

```bash
# 初始化本地 KV
npx wrangler dev --local
# 看到 "Ready" 后按 Ctrl+C 停止
```

#### 7. 启动服务

**方式 A：直接运行（测试用）**
```bash
node server.js
```

**方式 B：使用 PM2 常驻运行（推荐）**
```bash
# 安装 PM2
npm install -g pm2

# 启动服务
pm2 start server.js --name aetheria

# 设置开机自启
pm2 startup
pm2 save
```

#### 8. 配置 Nginx 反向代理（可选但推荐）

```bash
# 安装 Nginx
apt install -y nginx

# 创建配置
nano /etc/nginx/sites-available/aetheria
```

粘贴以下内容（替换你的域名）：

```nginx
server {
    listen 80;
    server_name 你的域名.com;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

```bash
# 启用配置
ln -s /etc/nginx/sites-available/aetheria /etc/nginx/sites-enabled/
nginx -t
systemctl restart nginx
```

#### 9. 配置 SSL 证书（HTTPS，Telegram 要求）

```bash
# 安装 certbot
apt install -y certbot python3-certbot-nginx

# 申请证书（自动配置 Nginx）
certbot --nginx -d 你的域名.com
```

#### 10. 注册 Webhook

浏览器访问：`https://你的域名/setup-webhooks`

看到 `"ok": true` 表示成功。

#### VPS 方案 vs 免费方案对比

| 对比项 | 免费方案（Cloudflare） | VPS 方案 |
|--------|----------------------|----------|
| 费用 | **¥0** | ¥30-50/月 |
| 部署难度 | 简单 | 较复杂 |
| 维护 | 无需维护 | 需更新系统/安全 |
| 网络 | 全球 CDN 节点 | 取决于机房位置 |
| 适合 | 个人起步 | 业务量大/需要掌控 |
| Telegram 连通性 | 偶尔被墙 | 海外机房稳定 |

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

## 🤖 全自动运营教程（24 小时无人值守）

> 从零开始搭建一个**完全自动化**的订阅店铺：买家自助购买、自动开通、自动提醒、自动续费，全程无需人工干预。

### 第一步：构建自动化商品（卡密商品化）

```
商品 = 卡密批次
```

1. **确定商品**：例如「30 天标准会员」售价 30 元
2. **生成卡密**：`/gencard 100 30 30元`（一次生成 100 张备货）
3. **重复商品**：不同套餐分别生成
   - 月卡：`/gencard 50 30 30元`
   - 季卡：`/gencard 50 90 75元`
   - 年卡：`/gencard 50 365 240元`

### 第二步：配置自动化基础设施（一次性设置）

```
⚙️ 系统设置（部署时配置一次即可）
├── 🔗 上游池     → /addurl 添加所有上游线路
├── 🖼️ 收款码     → /setqr 上传收款码（多张自动轮换）
├── 💰 价格       → 点按钮设置套餐价格
├── 📅 时长       → 点按钮设置默认时长
├── 📢 公告       → 发布店铺公告
└── 📞 客服       → /service @客服用户名
```

### 第三步：开通自动化销售渠道

**渠道 A：社群/群聊卖码**
```
1. 生成卡密 → 复制一批到群里/发给代理
2. 买家拿到码 → 自己找前台 Bot 兑换 → 秒开通
3. ✅ 完全自动，你不用管
```

**渠道 B：网店/闲鱼上架**
```
1. 卡密作为"虚拟商品"上架
2. 买家拍下付款 → 平台自动发码
3. 买家兑换 → 秒开通
4. ✅ 平台+系统双重自动
```

**渠道 C：代理分销（自动裂变）**
```
1. 💰 分销系统 → ➕ 创建分销商 → 生成推广链接
2. 代理发推广链接 → 买家点击进入
3. 代理卖卡密 → 买家兑换 → 自动开通
4. ✅ 代理赚钱你收钱，全自动
```

### 第四步：启用自动运营机制（系统内置）

| 自动机制 | 说明 | 状态 |
|---------|------|------|
| ⏰ **到期自动提醒** | 到期前 3/1/0 天自动通知买家 | ✅ 默认开启 |
| 📊 **每日运营日报** | 每天自动推送昨日营收统计 | ✅ 默认开启 |
| 🔄 **自动续费** | 买家点续费链接 → 自动通知你 → 一键延长 | ✅ 内置 |
| 🔍 **自助查询** | 买家随时查自己订阅状态 | ✅ 内置 |
| 💬 **智能 FAQ** | 常见问题自动回答，不用你回复 | ✅ 内置 |
| 📜 **操作日志** | 所有关键操作自动记录 | ✅ 内置 |

### 第五步：日常运营流程（每天只需 5 分钟）

```
☀️ 早上（自动收到）
📊 每日运营日报 → 看昨天卖了多少

🕐 随时（有人买时）
💬 买家自动兑换 → 系统自动开通 → 你手机收到通知

🌙 晚上（可选操作）
📋 卡密统计 → 看库存 → 不够就 /gencard 补充
🗑️ 清理已用卡密 → 保持整洁
```

### 完整自动化流程图

```
┌─────────────────────────────────────────────────┐
│              全自动销售闭环                       │
│                                                 │
│  生成卡密 ──→ 分发渠道 ──→ 买家购买             │
│  (备货)       (群/网店/代理)  (付款拿码)         │
│                                                 │
│  买家兑换 ──→ 系统自动开通 ──→ 收到订阅链接      │
│  (自助)       (无需审核)      (秒到账)          │
│                                                 │
│  到期前提醒 ──→ 买家续费 ──→ 自动延长            │
│  (自动)        (一键操作)    (继续使用)          │
│                                                 │
│  每日日报 ──→ 你查看营收 ──→ 补充卡密           │
│  (自动推送)    (5分钟)      (循环)              │
└─────────────────────────────────────────────────┘
```

### 全自动 vs 半自动对比

| 环节 | 半自动（人工审核） | **全自动（卡密模式）** |
|------|------------------|---------------------|
| 下单 | 买家选套餐 | 买家买卡密 |
| 付款 | 扫码付款 | 平台/线下付款 |
| 核验 | ⚠️ 你人工看截图 | ✅ 系统自动 |
| 开通 | ⚠️ 你点确认 | ✅ 兑换即开通 |
| 提醒 | 自动 | 自动 |
| 续费 | 自动 | 自动 |
| **人工干预** | **每单都要** | **零干预** |

### 全自动模式的赚钱思路

```
1. 卡密 = 预付商品，先收钱后给码（零风险）
2. 多渠道分发（群/网店/代理）= 流量自动进来
3. 自动开通+提醒+续费 = 服务全自动
4. 你只做两件事：补充卡密 + 查看日报
```

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
├── worker.js              主程序（全部逻辑，Cloudflare Workers 版）
├── server.js              VPS 服务器运行适配器（Node.js 版）
├── package.json           Node.js 项目配置（VPS 版用）
├── wrangler.toml          本地部署配置（敏感，已 gitignore）
├── wrangler.toml.example  配置模板（GitHub 共享）
├── .dev.vars.example      本地开发变量模板
├── .gitignore             排除敏感文件
├── README.md              本文档
└── LICENSE                MIT 协议
```

**双模式说明**：
- **免费模式**（Cloudflare Workers）：只用 `worker.js`
- **VPS 模式**（自建服务器）：用 `server.js` + `worker.js` + `package.json`

---

## ⚖️ 免责声明

本项目仅供技术学习与研究。请遵守当地法律法规，请勿用于非法用途。使用者需自行承担相关责任。

---

## 📄 License

MIT
