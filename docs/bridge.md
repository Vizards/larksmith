# Agent 使用指南

larksmith 通过远程 MCP 提供官方飞书 CLI 能力。Agent 按任务选择账号，发现命令，
执行读写，并通过图片和文件工具取得实际内容。

## 选择账号

调用 `lark_bridge_status` 查看已配置账号及授权状态。每个业务工具都通过 `account`
指定账户别名，例如 `primary` 或 `team-a`。这使同一 Agent 可以在不同任务间切换身份。

账号需要连接时，调用 `lark_connect_account` 的 `start`，展示返回的飞书验证链接；
用户完成授权后调用 `complete`。正常业务调用按需续期，每日维护也会主动续期。

## 发现并执行命令

1. 用 `lark_cli_catalog` 的 `query` 搜索，沿 `nextOffset` 翻页。
2. 将返回的 `command` 数组再次传入 catalog，查看参数、风险、执行条件和 API JSON Schema。
3. 用 `lark_cli_help` 查看官方帮助；通过 `skill="lark-doc/..."` 读取相关指南。
4. 读取使用 `lark_cli_read`，写入使用 `lark_cli_write`，传入选定 `account` 和参数对象。

参数键使用官方 flag 名称，省略 `--`。对象转换为内联 JSON，列表展开为重复 flag。
例如 `drive/files/copy` 的参数为：

```json
{
  "file-token": "SOURCE",
  "data": {"folder_token": "TARGET", "name": "Copy", "type": "docx"}
}
```

目录由 CLI schema 和官方 help 生成，默认搜索只列可派发的 user 命令，过滤后再分页。
`includeUnavailable=true` 用于诊断上游完整目录；不会启用 bot、文件路径或其他受限能力。
直接查不可用命令时返回限制与已确认的 `alternatives`，默认不返回可直接照抄的执行参数。
搜索中的 `alternativeRoutes` 也会指出专用工具入口。没有已确认的替代路径时不猜测。

例如原始 `im chats create` 的上游元数据仅支持 bot，但 `im +chat-create` 支持 user；
应查后者的参数，不能直接搬用原始 JSON，也不能因此判定所有建群路径均不可用。
两个快捷命令 `im +chat-create`、`im +chat-update` 都不接受 avatar；自定义群头像用下方
IM 图片上传，再调用支持 user 的 `im chats update`。

必须传本地文件的原始命令不标为可派发；可选的 `blockedParameters` 也不能使用。
官方 help/skill 保留上游原文，可能包含 bot 或本地工作流，不能取代桥接目录判断。
`executable=true` 仍不证明用户已授权所有 scopes、资源可见或该操作已实测。

风险同时取自原始 API schema 和官方 help；help 支持风险标签后的括号说明。
仅一处提供已知风险时使用该值；未知、重复或相互冲突的标注会阻止调度。

执行器将 argv 直接交给 CLI，并设置该命令的 user 身份与风险策略。CLI 负责业务参数
校验和 API 调用。请求输入最大 256 KiB、输出最大 1 MiB、CLI 执行时间最长 120 秒；
大结果通过分页和显式窗口读取。MCP HTTP 请求体最大 512 KiB，工具参数最多包含
10,000 个嵌套数组元素或对象成员。

## 写入与回执

从 `lark_cli_catalog` 返回的 `writeRequest` 获取一个新 `requestId`，每个独立动作使用
不同 ID；重试时沿用原 ID 和参数，不修改其中的时间。ID 格式为
`w2_<Unix 毫秒时间>_<至少 8 位唯一后缀>`，有效期从生成时起固定为 **60 分钟**。
Agent 可生成相同格式的新 ID，也可直接使用目录或错误响应给出的建议值。

回执按请求独立加密存入 Redis，通过原子条件写入协调并发，没有全局 256 条上限。
有效期内完成的请求返回原结果；5 分钟内仍执行中的请求拒绝并发重复执行，超过 5 分钟
仍未确认的请求要求核对目标，不自动重跑。单条结果上限仍为 64 KiB。
请求过期后直接拒绝；Redis 在请求到期后额外保留 5 分钟供在途调用收尾，然后自动删除。
不依赖每天的清理任务，也不保留长期回执或永久防重复标记。

旧格式或过期 ID 会返回 `writeDisposition=not_dispatched` 和 `suggestedRequest`。
这只表示本次没有派发，不能证明此前没有成功；先核对目标，再决定是否用新 ID 补做。
不得把建议 ID 当作自动重试指令。旧版本正在执行的动作也必须完成核对后再替换。

修改已有内容时先读后写，并回读验证。高风险写入在取得用户授权后设置
`highRiskConfirmed=true`。发送消息、修改权限和删除资源都应依据明确的用户意图执行。

## 图片与文件

`lark_docs_image` 读取文档图片；`lark_messages_image` 读取聊天消息图片，两者均返回
原生 MCP 图像。消息图片传入官方 `om_` messageId 和同一 account；纯图片消息和
富文本 post 内图片都可读取。多图按零起始的 imageIndex 选择（默认 0），返回
availableImages；需要其他图片时继续指定序号。工具先读取当前消息，核验未撤回并
从真实图片元素提取 key，再通过官方 CLI 下载，不能用消息文字里伪造的引用代替。
支持 PNG、JPEG、GIF、WebP，每张最多 2 MiB；不自动缩图、不保证动画帧展示，暂不
读取消息表情、视频或通用附件。链接解析与图片读取是独立步骤，不自动批量下载整段聊天。

`lark_files_read` 读取 Drive 文件、文档附件或聊天文件（包括话题回复）。
聊天文件传 `source="message"`、官方 `om_` messageId，并将同一消息的 file_key
放入 fileToken；不能将 IM file_key 当作 Drive 或 Docx token。先用消息读取或
`lark_message_link_read` 定位，再读取文件：

```json
{
  "account": "team-a",
  "source": "message",
  "messageId": "om_MESSAGE_ID",
  "fileToken": "file_RESOURCE_KEY",
  "operation": "text"
}
```

工具先核验当前消息可见且未撤回、资源 key 确实属于消息，再下载实际字节。
支持 file/audio/media 消息和 post 中明确的 file 元素；合并转发容器、文件夹、贴纸
尚不支持。返回原始字节不等于解析 PDF、Office 或转录音视频；这些交给客户端处理。
`text` 仅适用于 UTF-8 文本；二进制使用 `chunk` 或 `resource`。
通用命令不再接受 `download-resources=true`，避免仅返回马上失效的服务器临时路径。

`lark_files_upload` 默认 `destination=drive`，创建 Drive 文件，返回文件 token、URL、
字节数和 SHA-256。IM 图片使用 `destination=im_image`，必须明确
`imageType=avatar` 或 `message`，返回 `imageKey`（上游 `image_key`）。两类 token 不可互换。

IM 图片上传复用官方 `im images create`、同一 user 身份、回执与临时文件清理。
支持 PNG/JPEG/GIF/WebP，按字节签名识别，最大 10,000,000 字节；尺寸由飞书校验：
头像不超过 4096×4096，GIF 同时不超过 2000×2000，其他消息图片不超过 12000×12000。
不自动转换、缩图或发送消息。其他图片格式尚未纳入此传输适配。

群头像流程：上传 `imageType=avatar` → 取原样 `imageKey` → 使用同一账号调用
`lark_cli_write(command=["im","chats","update"], parameters={"chat-id":"oc_…","data":{"avatar":"返回的 imageKey"}})`
→ 回读群信息。上传本身不会修改群；更新前需要用户修改该群的授权。
不要自行补 `img_` 前缀：头像和消息图片返回的 key 格式可能不同。
`folderToken` 仅适用 Drive。Docx、邮件、Base 和通用 IM 文件上传不在新增目标范围内。

| 方式 | 用法 |
| --- | --- |
| 原生 `file`，`action=upload` | 传入客户端附件或生成文件，最大 32 MiB。 |
| `data`，`action=upload` | 传入实际 base64 字节，编码前最大 256 KiB。 |
| `begin → chunk → commit` | 最大 32 MiB；每片 256 KiB，末片可更小；提供总大小和 SHA-256。 |
| 读取 `info` / `text` / `chunk` | 下载最大 32 MiB；文本与二进制按显式字节窗口返回。 |
| 读取 `resource` / 图片 | 返回最大 2 MiB 的原生 MCP 内容。 |

原生附件使用 `openai/fileParams`：包含 `download_url`、`file_id`，以及可选的
`mime_type`、`file_name`。Chat 和 Work 可能向模型呈现字符串形式，此时传入客户端
运行环境中的实际文件路径，由平台转换为下载对象。其他客户端可使用 base64 或分块传输。

原生下载访问公开 HTTPS 目标，固定 DNS 解析结果，逐跳校验重定向，并限制时间和大小。
原生附件、小型 base64 和分块上传共用校验和与回执流程。`inputRoute` 标识实际输入方式。

分块上传绑定客户端、账号、requestId、文件名、目标、图片用途、大小和哈希。
`destination` / `imageType` 在 `begin` 时指定，后续 chunk/commit/status/cancel 不再传入。
相同分片可重复提交；
`status.stagedIndices` 包含已预留的位置，调用结果待确认时重新提交对应分片后再 commit。
文件分片加密暂存于私有 Blob，24 小时后过期，上传完成即清理；每日任务继续清理过期数据。
上传的 `begin` / `upload` 同样使用上述 60 分钟请求 ID；分块上传必须在这个窗口内
`commit`。暂存清单仍保留 24 小时，已完成上传可以通过清单回读结果；24 小时不延长
首次提交的写入有效期。过期后先核对目标，再取消暂存并重新开始。

暂存容量为最多 32 个上传清单、96 MiB 待完成文件。`cancel` 用于取消暂存任务；
已创建的飞书文件通过相应删除命令管理。取消暂存不撤销已上传的 IM 图片或群头像修改；
当前官方目录没有删除 IM 图片资源的入口，不承诺此类资源随群解散一并删除。

优先使用客户端原生附件，减少逐片请求。以 24 MiB 文件为例，分块方式需要 96 次 chunk
调用。读取不同字节窗口时会重新下载源文件；需要完整文件时可组装分片并核对 SHA-256。

## 特殊适配

业务命令使用通用调度。以下适配负责远程执行中的身份、文件与生命周期：

| 范围 | 处理方式与原因 |
| --- | --- |
| Auth、config、profile、update、doctor、whoami | 服务管理账号绑定、续期和固定 CLI 版本，统一完成运行环境配置。 |
| 图片、Drive 文件、文档附件 | 专用工具传输实际字节并返回 MCP 内容。上传目标为 Drive 文件与 IM 图片（avatar/message），它们的 CLI multipart 输入需要服务端固定临时文件。群设置继续通过通用派发，不另加建群专用工具。其他媒体位置未因此获得上传支持。 |
| `docs/+create`、`docs/+update` | 接收校验后的 DocxXML 子集，生成临时输入文件；支持已有 token 引用。 |
| Slides XML、mail HTML、Base form JSON | 内联内容及已有 token 引用走通用调度；带本地附件的工作流在 CLI 环境执行。 |
| file/path/output/upload/clipboard 参数 | 使用文件工具承接本地 I/O；混合 token/路径参数可通过支持 token 的原始 API 调用。 |
| apps、event、Drive 同步、`docs/+script` | 这些流程需要持久工作目录或长期执行，应在适合的 CLI 环境中运行。 |
| 身份与风险元数据 | 调度选择具有 user 身份和明确风险等级的命令。 |
| 表格与文档快捷工具 | 提供明确的表格范围、文档读取模式和图片输出。 |
| 聊天图片和文件传输 | `im/+messages-resources-download` 被上游标为 write，因为会写本地文件；专用工具固定 type=image 或 file、临时输出路径和 user 身份，仅执行远程读取，并返回真实 MCP 内容。完成或失败后清理临时目录。目录将该命令标为不可直接派发，消息列表的下载参数也引导到专用工具，不开放任意路径或修改上游风险分类。 |
| 复制消息链接（实验，默认关闭） | 公共 CLI 尚无 token 链接解析入口；使用网页只读 RPC 解析定位、文本快照；读取当前话题时先反查候选会话并精确比对内部 ID，再接回官方 CLI。明确的 oc_ + 非负 position 链接直接使用官方读取，分页和失败边界不隐藏。独立网页会话经身份核验和每日心跳维护；尚不能保证长期续期，也不下载媒体。见[实验范围](message-links-experiment.md)。 |

Base 记录读取在上游默认生成 NDJSON 文件；桥接通用调度显式指定 JSON，返回内联数据，
保留业务 `json` 参数。JSON 模式沿用上游较小的读取窗口（list 默认 100、最大 200），
继续通过显式分页取得大结果。远程目录同时检查原始 API 身份元数据与快捷命令的 `--as`
帮助；上游仅支持 bot 的命令不可派发，服务不会切换身份。

新增适配时在此说明原因和范围；普通命令的发现问题统一在目录生成器中处理。

## 客户端授权与维护

ChatGPT、Codex 和 Claude Code 使用各自 OAuth 客户端元数据连接服务。Claude Code 的
元数据地址为 `https://claude.ai/oauth/claude-code-client-metadata`，使用本机回环回调、
PKCE 和所有者登录。各客户端独立保存自己的 OAuth 凭据。

每日维护续期已配置账户并清理分片和回执，业务调用按需刷新。`lark_bridge_status`
提供账户到期时间、最近维护结果及需要处理的提示。年度授权提醒和维护检查见
[运维与用量](operations.md)。

CLI 维护步骤见 [贡献指南](../CONTRIBUTING.md)。

参考：[官方 CLI 扩展](https://github.com/larksuite/cli/tree/v1.0.98/extension)、
[OpenAI 文件输入](https://developers.openai.com/plugins/reference#define-file-inputs)、
[Vercel Node 运行时](https://vercel.com/docs/functions/runtimes/node-js)。
