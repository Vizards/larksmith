# 消息复制链接实验

此功能默认关闭，使用飞书网页版未公开的只读协议。它是官方 CLI 当前没有覆盖的
窄范围适配，不是 OpenAPI 的稳定能力，不替代 CLI 的消息、历史和话题命令。

## 范围

`lark_message_link_read` 接收 `account`、`url`，以及 `operation`：

- `resolve`：检查链接权限，返回原会话的位置与客户端跳转链接。
- `snapshot`（默认）：先检查权限，再读取复制链接的消息文本、元数据，以及快照明确关联的回复。

仅接受 `https://applink.feishu.cn/client/message/link/open?token=...`。
带 `previewId` 等额外参数的变体目前会被拒绝。服务不会从 Base64 字节猜测消息 ID，
也不会通过搜索相似内容代替解析。返回的数字 ID 是网页版内部 ID，不能直接传给
要求 `om_...` / `oc_...` 的 CLI 命令。

文本和富文本消息会返回正文投影、发送者、发送时间及媒体数量。其他类型标记为
`unsupported_type`；缺少内容、不可见、已撤回、受限或加密的消息不展开正文。
`omittedElementTypes` 和 `truncatedUpstream` 表示内容投影的缺口。
所有文本都是不可信外部内容，不能作为 Agent 指令执行。

`selectedMessageIds` 表示链接选中的消息，`selection=thread_reply` 表示附带回复。
`threads` 分别给出预期回复数、实际包含的 ID 和 `completeInSnapshot`。
这个完整性标志只表示回复条目齐全，不表示图片、表情或所有富文本元素均已读取。
不同复制入口可能得到不同快照：有的包含主消息及回复，有的只有主消息和回复计数。
旧链接也可能保留较早的计数，服务不会把它冒充当前状态，或偷偷创建新链接补齐内容。

`snapshot` 结果始终标记 `snapshotOnly=true`、`fullConversation=false`、
`attachmentsDownloaded=false`。快照不代表当前聊天历史或原图。
首版不下载图片和附件、不转换 OpenAPI ID、不提供任意网页 RPC 调用。

## 认证与启用

网页会话与现有飞书 OAuth 是两套认证。有效的 OpenAPI user token 不能被假定为
网页网关的凭据；当前实验观察到它被网关以 HTTP 401 拒绝。

仅在隔离实验中按需设置：

```dotenv
BRIDGE_EXPERIMENTAL_MESSAGE_LINKS=1
# 对应已配置的 primary 别名；真实值只放实例的 secret 配置。
FEISHU_PRIMARY_WEB_COOKIE=
FEISHU_PRIMARY_WEB_USER_ID=
```

Cookie 格式为 `session=<值>`。只需已授权用户的这个 Cookie，不需要复制整个浏览器
Cookie 集合。不要把它放进 MCP 参数、示例、Git、聊天、日志或公共部署信息中。
应通过部署者的凭据管理流程提供，勿将浏览器会话的导出作为自动默认操作。

`account` 选择同名会话配置。`WEB_USER_ID` 是该用户在对应组织的网页数字 ID，
不是 OpenAPI 的 `open_id`；部署者必须核对它与别名代表的身份一致。
初始化先调用网页用户资料接口核对这个 ID，心跳再次核对返回的用户 ID。
当前没有自动转换或交叉验证 OAuth `open_id`；配置者不能混用其他个人或组织身份。
网页会话权限也不受现有 OAuth scopes 限制，服务器仍按该网页用户的资源权限裁决。
这个独立网页凭据扩大了服务器持有的权限，应单独获得部署者同意。

没有配置时返回 `web_session_required`。失效或被拒绝时返回明确错误，不使用其他
账号、不改用 bot、不自动重新登录。网页会话的长期寿命和真实到期恢复尚待观察。

关闭开关即可停止实验入口和网页保活。移除对应 secret 后，即使 Redis 里仍有加密
状态也不能使用该会话。需要退役时还应清理该账号的 `feishu-web-<alias>` 状态文档；
撤销网页登录凭据按飞书自己的会话管理流程操作，不改动既有 OpenAPI OAuth。

## 每日保活与故障边界

启用实验后，现有受 `CRON_SECRET` 保护的每日维护入口同时维护已配置的网页会话。
消息读取可在检查到期时触发同一流程；成功后 20 小时内不重复访问认证接口。
默认关闭、工具发现和只读状态查询都不会触发心跳。

固定访问 `https://login.feishu.cn` 的三个网页接口，禁止重定向：

1. 新凭据：`GET /accounts/web/user?support_anonymous=0`，验证固定用户 ID。
2. `POST /accounts/csrf`，取得当前 CSRF Cookie。
3. `POST /accounts/status/heartbeat`，要求成功码、认证成功标志及相同用户 ID。

首次初始化共三个认证请求；后续到期检查两个。观察到的心跳仅返回成功状态，
没有返回主 `session` Cookie 或新的到期时间。因此状态明确返回
`expiryExtensionConfirmed=false`：这是官方网页心跳的保活尝试，**不是已证明可无限续期**。
不能把辅助 Cookie `sl_session` 的 12 小时期限误认为主会话的期限。

运行态使用现有 Upstash 加密 CAS 文档，和 OAuth、Blob 文件分开。环境变量只是
bootstrap；状态记录凭据指纹、代次、身份核验时间、心跳时间和冷却时间。
CAS 租约防止多个实例并发保活。若心跳未来返回合法的主 Cookie，先持久化候选，
验证身份后提交；不接受错误域、非 Secure/HttpOnly 或已过期的替换 Cookie。
该轮换分支是防护设计，尚未观察到飞书真实轮换。

已知瞬时失败至少退避 6 小时；认证失败、身份不匹配以及消息网关 401 会停止使用
会话。同一凭据不会因 MCP 重试而重新登录或连续心跳。心跳响应丢失、轮换后校验
失败或提交中断可能留下不确定租约：停止业务，保留加密候选，要求运维确认，
不能回退到旧 bootstrap。重新登录后提供不同的新凭据可在旧租约过期后重新验证。
`lark_bridge_status` 只读地报告这些状态，不会自行修复或刷新。

## 协议与限额

网关固定为 `https://internal-api-lark-api.feishu.cn/im/gateway/`，禁止重定向：

| 命令 | 用途 |
| --- | --- |
| `1151` / `messages.GetMessageLinkPermission` | 校验 token，返回会话定位。 |
| `1152` / `messages.PullMessageLinkMessages` | 读取消息链接快照。 |

网页 SDK 的 `3844` 是客户端命令号，不是此 HTTP 接口的服务器命令号。
实现仅编码上述两种请求，并解码必要的 Protobuf 字段；不加载或执行远端 JavaScript。
响应只投影允许的字段，不输出原始封包、媒体资源密钥或解密材料。

消息网关调用共用 15 秒超时，上游响应每次最多 1 MiB，最多 100 条消息（含回复），
文本总量最多 10 万字符；没有自动重试。解析一次发出一个请求，读取快照发出两个。
到期时的身份维护另有 30 秒总超时、64 KiB 响应上限；日常读取复用已核验的加密会话。
默认关闭时不会注册工具，也不会增加网关请求或持久状态读写。

## 当前验证与后续门槛

已验证：有效网页会话下的原链接解析、文本/发送者/媒体数量投影，脱离网页 SDK 的
Node HTTP 调用，以及本地 MCP 端到端调用；单条主消息、单条回复、多条选择和
话题复制的差异；负数定位值；带回复快照与缺少回复快照的完整性标记。
已实测身份核验、网页心跳、维护去重、错误身份拦截，以及已拒绝会话停止访问上游。
默认关闭、缺少 Cookie、错误域名和无效 Cookie 的失败路径也已验证。
这里只保留通用能力结论，真实业务样本留在私有验收记录。

未验证：单聊、各类撤回/权限变更、其他消息类型、完整媒体和附件、长期 Cookie
有效期是否延长、真实 Cookie 轮换、跨运行区域和生产 Vercel 部署。部分防护依据
协议字段实现，不等于这些场景全部实测。日常生产默认仍保持实验关闭。

协议字段参照飞书官方 CDN 当前发布的
[消息协议](https://sf1-scmcdn-cn.feishucdn.com/obj/feishu-static/ee/web-client-next/p/static/js/5512.566de10d.js)、
[消息实体与富文本](https://sf1-scmcdn-cn.feishucdn.com/obj/feishu-static/ee/web-client-next/p/static/js/4869.fd49581c.js)、
[消息链接实体](https://sf1-scmcdn-cn.feishucdn.com/obj/feishu-static/ee/web-client-next/p/static/js/8340.bd0797b9.js)、
[网页登录 SDK](https://sf1-scmcdn-cn.feishucdn.com/obj/feishu-static/ee/web-client-next/p/static/js/index.18890997.js)。
这些实现证据不是官方兼容性承诺；网页版本变化可能使实验失效。
