# 运维与用量

larksmith 将授权状态放在 Upstash，文件分片放在 Blob，并通过每日任务续期和清理。
Vercel Hobby、Upstash Redis Free 与 Blob 免费额度构成日常自托管方案。

## 查看运行状态

- `/health`：服务版本、维护模式、存储类型和 namespace。
- `lark_bridge_status`：各账号的授权状态、令牌到期时间、refreshCount、最近维护结果和提示。
- `/mcp`、`/token`、维护请求日志：HTTP 状态、耗时及 `stateOps` 计数。
- `daily_maintenance` 日志：每日续期和清理结果。

连续 48 小时没有成功维护时，状态会显示 `daily_maintenance_overdue`。
结合 Vercel Cron 运行记录检查任务是否调度成功，以及函数日志中的具体错误。

## 观察免费额度

在服务商控制台查看以下指标：

| 服务 | 主要指标 |
| --- | --- |
| Upstash | Commands、读写数、Bandwidth、Storage、Cost、Free 计划与 eviction 设置 |
| Vercel Functions | 调用数、Active CPU、Provisioned Memory |
| Vercel Blob | Simple/Advanced Requests、Data Transfer、Storage |

使用相同统计周期比较增量，结合真实使用频率观察趋势。Upstash 账单以服务商计量为准；
`stateOps` 记录应用逻辑操作，一次 Lua 调用可能包含多条 Redis 命令。

优先使用原生附件传输，减少分块请求；选择适当的读取窗口与分页；定期确认过期分片
已清理。这些做法有助于把运行保持在免费额度内。

方案说明：[Vercel Hobby](https://vercel.com/docs/plans/hobby)、
[Upstash Redis Free](https://upstash.com/pricing/redis)、
[Vercel Blob](https://vercel.com/docs/vercel-blob/usage-and-pricing)。

## 请求与状态处理

MCP 使用 POST 的 JSON 响应；GET/HEAD 返回 405。OAuth discovery 和资源元数据静态提供，
声明 `lark:read lark:write`。每次正常授权检查读取当前 Grant，状态更新使用原子条件写入。

存储暂时不可用时，服务返回 503 和 `Retry-After: 60`。每个热实例使用短暂熔断并合并
进行中的读取。确定性的 refresh 错误通过 HMAC 指纹缓存 60 秒，最多 256 条，帮助减少
重复请求；成功刷新更新共享状态并轮换令牌。

Blob 使用 identity 编码保持条件写入所需的 ETag。每次工具参数最多包含 10,000 个嵌套
元素，HTTP 请求体最大 512 KiB；较大文件通过原生附件或分块工具传输。

## 授权续期

每日维护主动刷新飞书 user token，普通调用也会按需刷新。刷新租约协调并发兑换，
先保存候选令牌，再核验用户身份。结果待确认时检查候选状态和目标账号，再按状态提示恢复。

MCP access token 有效期 12 小时；refresh/grant 使用 10 年滚动空闲窗口。
状态页同时提供飞书年度授权提醒。出现 `user_authorization_required` 时，
对该账号重新执行 `lark_connect_account` 授权流程。

## 维护与升级

`BRIDGE_MAINTENANCE_MODE=1` 暂停 OAuth、MCP 和 Cron，保留健康检查；完成维护后恢复为 `0`。
生产 Cron 使用 `CRON_SECRET` 鉴权，接受固定域名及当前生产部署的 `VERCEL_URL`。

升级或回退代码时，保留 issuer、签名/加密密钥、账号别名和最新持久状态。
密码管理器保存静态凭据，Redis 保存持续轮换的授权状态。具体步骤见 [版本升级](upgrade.md)。

写入使用稳定 `requestId`，结果待确认时先查询目标。分片过期后由每日维护清理，
清理失败时检查维护日志并恢复任务。
