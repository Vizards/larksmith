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

目录由 CLI schema 和官方 help 生成。固定版本 1.0.95 包含 783 项目录条目，
639 项通过命令级调度检查；各条目的 `executable`、参数说明和原因字段指导具体调用。
为所选账号配置对应 user scopes，并确认目标资源访问权限。

执行器将 argv 直接交给 CLI，并设置该命令的 user 身份与风险策略。CLI 负责业务参数
校验和 API 调用。请求输入最大 256 KiB、输出最大 1 MiB、CLI 执行时间最长 120 秒；
大结果通过分页和显式窗口读取。MCP HTTP 请求体最大 512 KiB，工具参数最多包含
10,000 个嵌套数组元素或对象成员。

## 写入与回执

为每次写入意图设置稳定的 `requestId`，重试时沿用同一个 ID。完成后的回执返回原结果；
同一 ID 对应相同参数。处理中或结果待确认的写入，先查询目标资源，再决定后续操作。
回执保存 30 天，最多 256 条；单条结果最大 64 KiB，整个加密回执文档最大 1 MiB。

修改已有内容时先读后写，并回读验证。高风险写入在取得用户授权后设置
`highRiskConfirmed=true`。发送消息、修改权限和删除资源都应依据明确的用户意图执行。

## 图片与文件

`lark_docs_image` 返回原生 MCP 图片。`lark_files_read` 读取 Drive 文件或文档附件，
`lark_files_upload` 创建 Drive 文件，返回文件 token、URL、字节数和 SHA-256。

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

分块上传绑定客户端、账号、requestId、文件名、大小和哈希。相同分片可重复提交；
`status.stagedIndices` 包含已预留的位置，调用结果待确认时重新提交对应分片后再 commit。
文件分片加密暂存于私有 Blob，24 小时后过期，上传完成即清理；每日任务继续清理过期数据。
暂存容量为最多 32 个上传清单、96 MiB 待完成文件。`cancel` 用于取消暂存任务；
已创建的飞书文件通过相应删除命令管理。

优先使用客户端原生附件，减少逐片请求。以 24 MiB 文件为例，分块方式需要 96 次 chunk
调用。读取不同字节窗口时会重新下载源文件；需要完整文件时可组装分片并核对 SHA-256。

## 特殊适配

业务命令使用通用调度。以下适配负责远程执行中的身份、文件与生命周期：

| 范围 | 处理方式与原因 |
| --- | --- |
| Auth、config、profile、update、doctor、whoami | 服务管理账号绑定、续期和固定 CLI 版本，统一完成运行环境配置。 |
| 图片、Drive 文件、文档附件 | 专用工具传输实际字节并返回 MCP 内容。Drive 上传和 Drive/Docx media 下载已适配；其他媒体位置使用对应的媒体 token 流程。 |
| `docs/+create`、`docs/+update` | 接收校验后的 DocxXML 子集，生成临时输入文件；支持已有 token 引用。 |
| Slides XML、mail HTML、Base form JSON | 内联内容及已有 token 引用走通用调度；带本地附件的工作流在 CLI 环境执行。 |
| file/path/output/upload/clipboard 参数 | 使用文件工具承接本地 I/O；混合 token/路径参数可通过支持 token 的原始 API 调用。 |
| apps、event、Drive 同步、`docs/+script` | 这些流程需要持久工作目录或长期执行，应在适合的 CLI 环境中运行。 |
| 身份与风险元数据 | 调度选择具有 user 身份和明确风险等级的命令。 |
| 表格与文档快捷工具 | 提供明确的表格范围、文档读取模式和图片输出。 |

新增适配时在此说明原因和范围；普通命令的发现问题统一在目录生成器中处理。

## 客户端授权与维护

ChatGPT、Codex 和 Claude Code 使用各自 OAuth 客户端元数据连接服务。Claude Code 的
元数据地址为 `https://claude.ai/oauth/claude-code-client-metadata`，使用本机回环回调、
PKCE 和所有者登录。各客户端独立保存自己的 OAuth 凭据。

每日维护续期已配置账户并清理分片和回执，业务调用按需刷新。`lark_bridge_status`
提供账户到期时间、最近维护结果及需要处理的提示。年度授权提醒和维护检查见
[运维与用量](operations.md)。

CLI 维护步骤见 [贡献指南](../CONTRIBUTING.md)。

参考：[官方 CLI 扩展](https://github.com/larksuite/cli/tree/v1.0.95/extension)、
[OpenAI 文件输入](https://developers.openai.com/plugins/reference#define-file-inputs)、
[Vercel Node 运行时](https://vercel.com/docs/functions/runtimes/node-js)。
