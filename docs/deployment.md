# 部署 larksmith

使用 Vercel Hobby、Upstash Redis Free 和 Vercel Blob 免费额度，搭建自己的飞书 MCP。
准备 Node.js 24、飞书应用和目标账号后，按以下步骤完成配置与接入。

## 1. 创建 Vercel 项目

选择 Hobby 方案，项目配置为：

| 配置 | 值 |
| --- | --- |
| Node.js | 24 |
| Framework Preset | Other |
| Root Directory | 仓库根目录 |
| Build Command | `npm run build` |

将固定 HTTPS origin 配置为 `BRIDGE_ISSUER`，格式为 `https://mcp.example.com`。
OAuth 与 MCP 使用这个地址；每日维护也接受当前生产部署的 Vercel 生成域名。

仓库默认仅允许 `main` 自动部署；将 Vercel 的 Production Branch 设置为 `main`。
完成生产配置后再关联仓库。其他分支启用 Preview 前，准备独立的凭据、issuer、Redis
和 Blob store，再调整 [Git 部署配置](https://vercel.com/docs/project-configuration/git-configuration)。
也可以通过 Vercel CLI 从选定提交创建暂存生产部署，验证后再发布。

使用 `.env.example` 查看配置字段，再逐项加入 Vercel 环境变量。生产凭据设置为
Production 专用；开发、测试和 Preview 使用各自独立的数据库、存储及凭据。
CI 使用 `https://mcp.example.com` 作为测试地址。

## 2. 配置飞书账号

每个账号需要对应应用的 App ID、App Secret、目标用户在该应用下的 `open_id`，
以及已开通的 user scopes。应用应支持官方 CLI 的 device authorization 和 refresh
流程，可见范围包含所选用户。

应用准备参考 [官方 CLI 入门](https://github.com/larksuite/cli/blob/v1.0.98/README.md)。
通过该应用的官方 `auth status` 或 `/open-apis/authen/v1/user_info` 获取用户身份。
服务将实际登录用户与 `expectedOpenId` 核对，完成账号绑定。

复制 `config/accounts.example.json` 的结构，替换占位符，将 JSON 写入 Production
环境变量 `FEISHU_ACCOUNTS_JSON`：

```json
{
  "primary": {
    "appId": "cli_REPLACE_APP_ID",
    "expectedOpenId": "ou_REPLACE_OPEN_ID",
    "label": "Primary",
    "brand": "feishu",
    "scopes": ["offline_access", "docx:document:readonly"]
  }
}
```

增加同结构的对象即可连接更多账号。支持 1–16 个账户；别名以小写字母开头，使用
小写字母、数字和连字符，最长 32 字符，避开 `constructor`、`prototype` 等保留名称。
`label` 用作显示名称。别名进入状态地址和写入回执，投入使用后保持稳定。
Agent 在每次调用的 `account` 字段中填写别名，即可选择账号。

App Secret 单独保存为 `FEISHU_<ALIAS>_APP_SECRET`，其中别名转为大写、连字符换成
下划线。例如 `primary` 对应 `FEISHU_PRIMARY_APP_SECRET`，`team-a` 对应
`FEISHU_TEAM_A_APP_SECRET`。JSON 中的 `brand` 填写 `feishu`。

保留 `offline_access` 用于续期；按计划使用的文档、表格、消息等能力，开通相应
应用权限并完成 user 同意。上面的示例提供文档只读权限。

## 3. 初始化实例凭据

全新实例执行：

```sh
npm ci --ignore-scripts
npm run setup -- /安全的仓库外目录/larksmith-secrets
```

父目录须已存在，输出目录由脚本新建。生成的文件权限为 0600、目录权限为 0700。
将这些值备份到密码管理器，并配置 Vercel Production 敏感环境变量：

| 名称 | 用途 |
| --- | --- |
| `BRIDGE_STATE_KEY` | 32 字节 base64url，状态与文件加密 |
| `BRIDGE_JWKS` | 带固定 kid 的私有 ES256 签名密钥 |
| `BRIDGE_OWNER_HASH` | scrypt 登录密码哈希 |
| `CRON_SECRET` | 每日维护鉴权 |
| `FEISHU_<ALIAS>_APP_SECRET` | 对应账号的飞书 user OAuth |

`OWNER_PASSWORD` 保存在密码管理器，供所有者登录使用。`BRIDGE_OWNER_ID` 默认值为
`owner`，作为固定 OAuth subject。通过 Vercel 设置界面，或 `vercel env add NAME production`
的标准输入导入服务端凭据。已有实例升级时沿用原密钥，参见 [版本升级](upgrade.md)。

## 4. 连接 Upstash 与 Blob

通过 Vercel Marketplace 创建 **Upstash Redis Free** 实例，选择与函数就近的区域，
关闭 eviction，并保留 Free 计划。Redis 保存持久授权状态。

```dotenv
BRIDGE_STORAGE_NAMESPACE=main
UPSTASH_REDIS_REST_URL=https://YOUR_DATABASE.upstash.io
UPSTASH_REDIS_REST_TOKEN=REPLACE_IN_SECRET_SETTINGS
BRIDGE_MAINTENANCE_MODE=0
```

Marketplace 注入的 `KV_REST_API_URL` / `KV_REST_API_TOKEN` 可直接使用；自行配置时
使用上面的 `UPSTASH_REDIS_REST_*`，该组变量优先。选择一组维护即可。
`BRIDGE_STORAGE_BACKEND` 可省略，显式配置时填写 `upstash`。
namespace 以小写字母或数字开头，包含小写字母、数字和连字符，最长 64 字符。

在同一 Vercel 项目下连接 **private Blob store**，设置 `BLOB_STORE_ID`，保持 Vercel
系统环境变量启用。项目通过 OIDC 访问 Blob。文件分片加密存入 Blob，上传清单、
OAuth 和飞书令牌等状态保存在 Redis。参考 [Blob SDK](https://vercel.com/docs/vercel-blob/using-blob-sdk)。

计划与额度：[Vercel Hobby](https://vercel.com/docs/plans/hobby)、
[Upstash Redis Free](https://upstash.com/pricing/redis)、
[Vercel Blob](https://vercel.com/docs/vercel-blob/usage-and-pricing)。

## 5. 部署与接入 Agent

将通过检查的改动合入 `main` 后，Vercel 自动部署。首次上线或需要先验证生产构建时，可使用
[staged production deployment](https://vercel.com/docs/deployments/promoting-a-deployment)，
验证后再 promote 到固定域名。

1. 检查 `/health` 返回 `service=larksmith`、`maintenance=false`、`storage.kind=upstash`
   以及配置的 namespace。
2. 在 MCP 客户端添加 `https://你的域名/mcp`，使用实例所有者密码登录并允许连接。
3. 调用 `lark_bridge_status` 查看账号别名，对目标账户调用 `lark_connect_account/start`。
4. 打开返回的飞书验证链接，以预期用户授权；确认完成后调用 `complete`。
5. 用专用测试资源验证读取和写入；写入使用稳定 requestId，并回读、清理。文件传输
   核对实际字节与 SHA-256。工具列表更新后，在客户端刷新连接。
6. 在 Vercel Cron 控制台执行一次 Run，确认维护日志和最近成功时间，再观察每日调度。

`vercel.json` 每日 `0 1 * * *` UTC 调用 `/internal/maintenance`，使用 `CRON_SECRET`
鉴权，续期账号并清理上传分片和回执。Hobby 在该小时内调度，详情见
[Cron 管理](https://vercel.com/docs/cron-jobs/manage-cron-jobs)。

## 开发与测试

默认测试使用合成身份和内存存储。验证 Linux x64 / Node 24 CLI 运行：

```sh
BUILD_RUNTIME_PROBE=1 BRIDGE_ISSUER=https://mcp.example.com npm run build
npm run probe
```

macOS 可使用 Linux x64 容器。probe 检查 CLI version/help、并发临时目录隔离和清理。
`BUILD_RUNTIME_PROBE=1` 为测试构建添加 `/api/probe` 诊断路由；生产构建保持该变量未设置。

测试真实 Redis 时，向进程注入独立测试数据库的 REST URL/token，再运行：

```sh
TEST_REDIS_CLOUD=1 node --test test/redis-cloud.test.mjs
```

该检查使用随机命名空间验证 Lua/CAS、撤销和 Grant 投影，结束后清理数据。
云端操作计入测试数据库用量。
