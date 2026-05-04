# Render Service Manager - 单文件版

基于 [render-service-manager](https://github.com/ssfun/render-service-manager) 项目打包的 Cloudflare Worker 单文件版本。

## 功能

- 🛡️ 多 Render 账户统一管理
- 📊 服务状态实时监控面板
- 🚀 一键部署 / 暂停 / 恢复 / 重启
- 🔧 环境变量在线编辑
- 📋 事件日志与部署历史查看
- 📈 实例扩缩容管理
- 🔒 登录防暴力破解、CSRF 防护、CSP 安全策略
- ⏰ 定时保活 Ping（Cron 每5分钟）
- 📦 服务数据缓存（软/硬 TTL）

## 快速部署

### 1. 安装 Wrangler CLI

```bash
npm install -g wrangler
```

### 2. 登录 Cloudflare

```bash
wrangler login
```

### 3. 配置环境变量

编辑 `wrangler.toml`，设置管理员账号密码：

```toml
[vars]
ADMIN_USERNAME = "your_admin_username"
ADMIN_PASSWORD = "your_admin_password"
```

### 4. 创建 KV 命名空间

```bash
wrangler kv namespace create RENDER_KV
```

将返回的 `id` 填入 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "RENDER_KV"
id = "your_kv_namespace_id"
```

### 5. 部署

```bash
wrangler deploy
```

## 使用

部署完成后，访问 Worker URL 即可进入管理面板。首次使用需：

1. 使用配置的管理员账号密码登录
2. 进入「账户管理」页面，添加 Render API Key
3. 返回仪表盘，即可查看和管理所有服务

## 注意事项

- **无需 `npm install`**，此版本为纯单文件 Worker，直接部署即可
- Render API Key 需在 [Render Dashboard](https://dashboard.render.com/user/api-keys) 获取
- 定时任务默认每5分钟执行一次服务保活 Ping
- 如需修改 Cron 频率，编辑 `wrangler.toml` 中的 `crons` 配置
