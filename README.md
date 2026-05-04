<p align="center">
  <h1 align="center">Render Service Manager</h1>
  <p align="center">
    <strong>Render 多账户服务管理面板 — 单文件精炼版</strong><br>
    零依赖 · 零构建 · 单文件 Cloudflare Workers 部署
  </p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Cloudflare-Workers-f38020?logo=cloudflare" alt="Workers" />
  <img src="https://img.shields.io/badge/Render-REST_API-6ac06b?logo=render" alt="Render" />
  <img src="https://img.shields.io/badge/Type-0_Depencies-green" alt="零依赖" />
  <img src="https://img.shields.io/badge/Size-234KB_Single_File-blue" alt="单文件" />
  <img src="https://img.shields.io/badge/License-MIT-green" alt="MIT" />
</p>

> 基于原版 [render-service-manager](https://github.com/ssfun/render-service-manager) 精炼打包为单文件版本，保留全部功能，无任何依赖。

---

## 功能特性

| 功能 | 说明 |
|------|------|
| **多账户管理** | 集中管理多个 Render 账户 API Key，支持添加、编辑、删除、连接测试 |
| **服务概览** | 仪表盘卡片式展示所有 WEB_SERVICE 类型的服务，状态一目了然 |
| **服务控制** | 一键暂停、恢复、重启服务 |
| **部署管理** | 触发新部署、查看部署历史、取消进行中的部署、回滚到指定版本 |
| **环境变量** | 在线查看、添加、编辑、删除服务的环境变量，支持批量替换 |
| **实例管理** | 查看服务实例状态，支持扩缩容 |
| **日志查看** | 终端风格日志查看器，支持按级别过滤（error/warn/info） |
| **事件日志** | 查看服务事件时间线 |
| **定时保活** | Cron 每 5 分钟自动 Ping 活跃服务，防止休眠 |
| **智能缓存** | 三级 TTL 缓存（新鲜15分钟 → 过期后台刷新 → 24小时强制刷新） |
| **安全防护** | CSRF 双重提交 Cookie、暴力破解保护、时序安全密码比较、CSP Nonce、HSTS |

## 环境要求

- 一个 [Cloudflare](https://dash.cloudflare.com/sign-up) 账号（免费计划即可）
- 一个 [Render](https://dashboard.render.com/register) 账号及 [API Key](https://dashboard.render.com/user/api-keys)

---

## 方式一：CLI 命令行部署（推荐）

### 第 1 步：克隆项目

```bash
git clone https://github.com/qizhuxu/render-service-manager-single.git
cd render-service-manager-single
```

### 第 2 步：登录 Cloudflare

```bash
npx wrangler login
```

浏览器会自动打开 Cloudflare 授权页面，点击 **Allow** 完成授权。成功后会看到：

```
Successfully logged in.
```

### 第 3 步：创建 KV 命名空间

应用使用 Cloudflare KV 存储会话、账户信息和缓存数据：

```bash
npx wrangler kv namespace create RENDER_KV
```

执行成功后会返回命名空间 ID：

```
🗓  Creating namespace with title "render-manager-RENDER_KV"
✨  Success!
Add the following to your configuration file in your kv_namespaces configuration:
[[kv_namespaces]]
binding = "RENDER_KV"
id = "f6e5d4c3b2a1..."
```

**记下这个 `id`，下一步要用。**

### 第 4 步：配置 wrangler.toml

编辑 `wrangler.toml` 文件，填入 KV 命名空间 ID 和管理员账号：

```toml
name = "render-manager"
main = "worker.js"
compatibility_date = "2026-01-20"

# === 填入第 3 步创建的 KV ID ===
[[kv_namespaces]]
binding = "RENDER_KV"
id = "f6e5d4c3b2a1..."    # ← 替换为你的实际 ID

[triggers]
crons = ["*/5 * * * *"]    # 每 5 分钟执行一次保活 Ping

[vars]
ADMIN_USERNAME = "admin"                # ← 改为你自己的用户名
ADMIN_PASSWORD = "your_strong_password" # ← 改为你自己的密码（建议通过 secret 设置）
```

### 第 5 步：设置管理员密码（更安全的方式）

通过 Wrangler Secrets 设置密码，避免明文出现在配置文件中：

```bash
npx wrangler secret put ADMIN_USERNAME
# 提示输入后填入你想要的管理员用户名

npx wrangler secret put ADMIN_PASSWORD
# 提示输入后填入你想要的管理员密码
```

设置 Secret 后会覆盖 `wrangler.toml` 中的同名变量。

### 第 6 步：部署

```bash
npx wrangler deploy
```

成功后会输出：

```
Published render-manager (2.34s)
  https://render-manager.<your-subdomain>.workers.dev
```

打开这个链接即可访问管理面板！

---

## 方式二：Cloudflare 控制台部署（无需终端）

如果你不想使用命令行，可以通过 Cloudflare Dashboard 完成全部操作。

### 第 1 步：下载代码

在 GitHub 仓库页面点击 **Code → Download ZIP**，解压后你只需要 `worker.js` 和 `wrangler.toml` 两个文件。

### 第 2 步：登录 Cloudflare Dashboard

打开 [https://dash.cloudflare.com](https://dash.cloudflare.com)，登录你的账号。

### 第 3 步：创建 KV 命名空间

1. 在左侧菜单中点击 **Workers & Pages → KV**
2. 点击 **Create a namespace**
3. 名称输入 `RENDER_MANAGER_KV`（任意名称均可，用于识别）
4. 点击 **Add**
5. **记下创建后的 Namespace ID**（格式类似 `f6e5d4c3b2a1...`）

### 第 4 步：创建 Worker

1. 在左侧菜单中点击 **Workers & Pages → Overview**
2. 点击 **Create** 按钮
3. 选择 **Create Worker**
4. 名称输入 `render-manager`（或任意名称）
5. 点击 **Deploy**
6. 部署完成后点击 **Edit Code** 进入代码编辑器
7. **删除编辑器中的所有默认代码**，然后将 `worker.js` 的全部内容粘贴进去
8. 点击右上角 **Deploy** 保存

### 第 5 步：绑定 KV 命名空间

1. 回到 Worker 概览页，点击 **Settings → Bindings**
2. 点击 **Add** → 选择 **KV Namespace**
3. **Variable name** 必须填写 `RENDER_KV`（**必须与代码中一致**）
4. KV Namespace 选择你在第 3 步创建的命名空间
5. 点击 **Deploy**

> ⚠️ **重要**：Variable name 必须是 `RENDER_KV`，不能写错，否则应用无法读写数据。

### 第 6 步：设置环境变量（管理员账号）

1. 仍在 Settings 页面，点击 **Variables and Secrets**
2. 点击 **Add**，分别添加两个变量：
   - 变量名 `ADMIN_USERNAME`，值填你想要的管理员用户名
   - 变量名 `ADMIN_PASSWORD`，值填你想要的管理员密码
3. 点击 **Encrypt**（加密存储更安全）→ **Deploy**

### 第 7 步：配置 Cron 触发器（保活 Ping）

1. 在 Worker 概览页点击 **Triggers → Cron Triggers**
2. 添加 Cron 表达式：`*/5 * * * *`（每 5 分钟执行一次保活）
3. 点击 **Save**

> Cron 用于自动 Ping 活跃的 Render 服务，防止它们因为无流量而休眠。如果你不需要这个功能，可以跳过此步。

### 第 8 步：配置自定义域名（可选）

1. 在 Worker 概览页点击 **Settings → Domains & Routes**
2. 点击 **Add** → **Custom Domain**
3. 输入你自己的域名（需先将域名 DNS 托管到 Cloudflare）
4. 点击 **Add Domain**

例如配置 `render.yourdomain.com` 后即可通过该域名访问管理面板。

---

## 首次使用

### 1. 登录

访问你的 Worker URL（如 `https://render-manager.<subdomain>.workers.dev`），输入在部署时设置的管理员用户名和密码。

### 2. 添加 Render 账户

1. 登录后点击右上角 **账户管理**
2. 点击 **添加账户**
3. 填写：
   - **账户名称**：方便识别，如"公司账号"、"个人账号"
   - **API Key**：你的 Render API Key
4. 点击 **测试连接**，验证 API Key 是否有效
5. 测试通过后点击 **保存**

**如何获取 Render API Key：**

1. 登录 [https://dashboard.render.com](https://dashboard.render.com)
2. 点击右上角头像 → **Account Settings**
3. 左侧菜单选择 **API Keys**
4. 点击 **Create API Key**
5. 复制生成的 Key

### 3. 管理服务

返回仪表盘，你可以：

- **查看服务状态**：绿色圆点 = 运行中，灰色 = 已暂停
- **搜索筛选**：输入关键词搜索服务，按账户下拉筛选
- **服务控制**：每个服务卡片上有部署、暂停/恢复、重启按钮
- **查看详情**：点击卡片展开环境变量、日志、事件、部署历史、实例管理弹窗

---

## 安全说明

| 安全措施 | 说明 |
|----------|------|
| **CSRF 防护** | 双重提交 Cookie，所有写操作（POST/PUT/DELETE）需验证 CSRF Token |
| **暴力破解** | IP + 用户名双重追踪，5 次失败后指数退避锁定（5→10→20→40→60 分钟） |
| **时序安全** | 密码比较使用自定义时序安全算法，防止侧信道攻击 |
| **会话安全** | HttpOnly + SameSite=Strict Cookie，24 小时滑动过期（活动 >5 分钟自动续期） |
| **安全头** | HSTS（一年）、CSP（Nonce 动态白名单）、X-Frame-Options: DENY、COOP/COEP、Referrer-Policy: no-referrer |
| **输入验证** | `safeParseJson` 安全 JSON 解析、`escapeHtml` XSS 防护、`sanitizeUrl` URL 白名单 |
| **API Key 存储** | 加密存储于 KV，前端仅显示脱敏版本（前 8 位...后 4 位） |

---

## 自定义配置

在 `wrangler.toml` 中可调整以下参数：

```toml
[triggers]
crons = ["*/5 * * * *"]    # 保活频率
# crons = ["*/10 * * * *"]  # 每 10 分钟
# crons = ["0 * * * *"]     # 每小时
```

---

## API 接口

所有 API 需要登录后访问，写操作需要 CSRF Token。

### 账户管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/accounts` | 账户列表（Token 脱敏） |
| POST | `/api/accounts` | 添加账户 |
| POST | `/api/accounts/test` | 测试 API Key |
| PUT | `/api/accounts/:id` | 更新账户 |
| DELETE | `/api/accounts/:id` | 删除账户 |

### 服务管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/services` | 服务列表（`?refresh=true` 强制刷新） |
| GET | `/api/services/:accId/:svcId` | 服务详情 |
| POST | `/api/services/:accId/:svcId/suspend` | 暂停服务 |
| POST | `/api/services/:accId/:svcId/resume` | 恢复服务 |
| POST | `/api/services/:accId/:svcId/restart` | 重启服务 |
| POST | `/api/services/:accId/:svcId/scale` | 扩缩容实例 |

### 部署管理

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/deploy` | 触发新部署 |
| GET | `/api/deploys/:accId/:svcId` | 部署历史 |
| POST | `/api/deploys/:accId/:deployId/cancel` | 取消部署 |
| POST | `/api/deploys/:accId/:deployId/rollback` | 回滚到指定部署 |

### 环境变量

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/env-vars/:accId/:svcId` | 环境变量列表 |
| PUT | `/api/env-vars/:accId/:svcId` | 批量替换环境变量 |
| PUT | `/api/env-vars/:accId/:svcId/:key` | 更新单个变量 |
| DELETE | `/api/env-vars/:accId/:svcId/:key` | 删除单个变量 |

### 监控

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/logs/:accId/:svcId` | 服务日志（`?level=error&limit=20`） |
| GET | `/api/instances/:accId/:svcId` | 实例列表 |
| GET | `/api/events/:accId/:svcId` | 事件日志 |

---

## 常见问题

**Q: 部署后访问页面显示空白或 500 错误？**
A: 检查 KV 命名空间是否已正确绑定。Variable name 必须精确为 `RENDER_KV`。

**Q: 登录后立即跳转回登录页？**
A: KV 绑定未正确配置，会话无法写入。重新检查 Bindings 设置。

**Q: 添加账户时测试连接失败？**
A: 确认 Render API Key 有效。API Key 在 [Account Settings → API Keys](https://dashboard.render.com/user/api-keys) 创建。

**Q: 服务列表为空？**
A: 确认你的 Render 账户下有 WEB_SERVICE 类型的服务。当前仅支持此类型。

**Q: 如何更新部署？**
A: CLI: `npx wrangler deploy`。控制台: 重新粘贴 worker.js → Deploy。

**Q: 如何修改管理员密码？**
A: CLI: `npx wrangler secret put ADMIN_PASSWORD`。控制台: Variables and Secrets 中修改。

**Q: Cron 保活不生效？**
A: 检查 Triggers → Cron Triggers 是否配置了 `*/5 * * * *`。免费版 Workers 限制 Cron 最多每小时执行 1 次，付费版无此限制。

**Q: 服务数据缓存多久？**
A: 三级 TTL：15 分钟内返回缓存；15 分钟 ~ 24 小时返回缓存 + 后台刷新；超过 24 小时同步刷新。可在仪表盘看到"数据更新于 X 分钟前"提示。

---

## 技术架构

```
┌─────────────────────────────────────────────┐
│              Cloudflare Workers              │
│  ┌──────────────────────────────────────┐   │
│  │         worker.js (单文件 234KB)      │   │
│  │  ┌──────────┐  ┌───────────────────┐ │   │
│  │  │  Router  │→ │    Handlers       │ │   │
│  │  │ (正则路由)│  │ auth/accounts/    │ │   │
│  │  │ + 中间件  │  │ services/         │ │   │
│  │  │ (CSRF)   │  │ envVars/events/   │ │   │
│  │  └──────────┘  │ monitoring/cron   │ │   │
│  │                 └────────┬──────────┘ │   │
│  │  ┌──────────┐           │             │   │
│  │  │  Views   │←──────────┘             │   │
│  │  │ (SSR)    │   HTML 字符串模板       │   │
│  │  └──────────┘                         │   │
│  │  ┌──────────┐  ┌───────────────────┐ │   │
│  │  │ Session  │  │  Render API       │ │   │
│  │  │ (Cookie) │  │  Client           │ │   │
│  │  └────┬─────┘  │ (自动分页+重试)   │ │   │
│  └───────┼────────┴───────────────────┘   │
│          │                                 │
│  ┌───────▼────────┐  ┌────────────────┐   │
│  │  Cloudflare KV │  │  Cron Trigger  │   │
│  │  会话/账户/缓存│  │  保活 Ping      │   │
│  │  登录尝试记录  │  │  (每5分钟)      │   │
│  └────────────────┘  └────────────────┘   │
└─────────────────────────────────────────────┘
         ↕ HTTPS
┌─────────────────────────────────────────────┐
│          Render API (api.render.com)         │
│  services / deploys / env-vars / logs       │
└─────────────────────────────────────────────┘
```

---

## 与原版的关系

本项目是 [render-service-manager](https://github.com/ssfun/render-service-manager) 的**单文件精炼版**：

| 对比项 | 原版 | 本版 |
|--------|------|------|
| 文件数量 | 22 个源文件 | 1 个 `worker.js` |
| 依赖 | wrangler (dev) | wrangler (dev) |
| 构建步骤 | 无需构建 | 无需构建 |
| 功能 | 全部功能 | 全部功能 |
| 部署方式 | `wrangler deploy` | `wrangler deploy` |
| 代码量 | ~4,800 行 | ~8,500 行（含注释和空行） |

## License

MIT
