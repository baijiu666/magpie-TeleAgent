# TeleAgent 3.0.1 桌面端：对话相关请求全表

> 证据源只有三个，本文不引用任何第三方实现：
> 1. `D:\TeleAgent\resources\app.asar`（3.0.1）里的 main / renderer bundle；
> 2. `%USERPROFILE%\.local\share\TeleAgent\runtimes\super-agent-code\bin\TeleAgent.exe`（Go 引擎）的字符串表与符号；
> 3. 引擎运行日志 `users/<owner>/log/super-agent-server-*.log` 与对上游的真机 A/B。
>
> **证据等级**：`[代码]` asar 里能读到的调用/配置；`[二进制]` 引擎字符串表；`[日志]` 本机实际跑出来的请求；
> `[实测]` 对上游发过真实请求；`[推断]` 由名字与调用点推断，未抓到 TLS 明文。

## 0. 架构：对话不是 renderer 直连上游

```
Renderer (React) ──HTTP/REST──▶ 本机 Go 引擎 (opencode server, 127.0.0.1)
                                   │
                                   ├─ 上游 LLM: /superCowork/sapi/api/v1/chat/completions
                                   ├─ 工具:     /api/v1/coworker/web_search
                                   └─ 安全:     /api/v1/security/instruction/review
Renderer ──HTTP──▶ 网关业务面: /api/v1/check/content、/api/v1/usage/sync 等
```

`[代码]` 主进程把 `OPENCODE_CONFIG_CONTENT`、`SUPER_AGENT_AUTH_STATE`（AES-256-GCM 加密的 token/设备信息）、
`SUPER_AGENT_APP_VERSION`、`OPENCODE_CLIENT`、`SUPER_AGENT_LOCAL_SESSION_KEY` 等注入引擎，再由引擎访问上游。

## 1. Renderer → 本机引擎（对话 UI 本身）

引擎日志里实际出现的本机路由（`[日志]`）：

| 方法 | 路径 | 作用 | 证据 |
|---|---|---|---|
| GET | `/global/event` | **SSE 事件流**：`message.part.delta` / `message.part.updated` / `message.updated` / `session.idle` / `session.error` / `permission.*` / `question.*` | `[日志]` 启动时建立；`[代码]` SDK `event()` |
| POST | `/session` | 新建会话（body：parentID/title/permission 等） | `[代码]` SDK `session.create()`；`[日志]` GET `/session` 列表 |
| POST | `/session/{sessionID}/message` | **发送一条用户消息**，AI 回复以流式事件回来 | `[代码]` SDK `session.prompt()`；renderer 调 `session.sendMessage(...)` |
| GET | `/session/{sessionID}/message` | 拉会话消息历史 | `[日志]` 实际出现 |
| GET | `/session/{sessionID}` | 会话详情 | `[日志]` 实际出现 |
| POST | `/session/{sessionID}/abort` | 停止当前生成 | `[代码]` SDK `session.abort()` |
| GET | `/session/status`、`/global/session/status` | 会话运行状态 | `[日志]` 实际出现 |
| GET | `/provider`、`/provider/auth` | 可用供应商 / 鉴权状态（模型选择器） | `[日志]` 实际出现 |
| GET | `/config`、`/global/config`、`PATCH /global/config` | 引擎配置（模型、provider、权限） | `[日志]` 实际出现 |
| GET | `/session/sync-source`、`/ready`、`/plugin`、`/experimental/tool/ids`、`/skill`、`/mcp` | UI 轮询的引擎状态 | `[日志]` 实际出现 |
| POST | `/session/onboarding/demo` | 新手引导示例会话 | `[日志]` 实际出现 |
| POST | `/session/{id}/command`、`/shell`、`/init`、`/summarize`、`/fork`、`/revert`、`/unrevert`、`/share`、`/todo`、`/permissions/{id}` | 会话内的其它动作（斜杠命令、终端、初始化、压缩、分叉、撤销、分享、待办、权限回复） | `[代码]` SDK 路由表 |

### 发送消息的真实请求

`[代码]` renderer 调：

```js
session.sendMessage({
  sessionId, queryId, messageId,
  parts: [{ content: { case: "text", value: { text } } }],
  providerId, modelId, agent, mode
}, {
  signal,
  headers: {
    "X-SuperAgent-Forward-Task-ID": taskId,        // 仅子任务
    "idempotency-key": queryId,                     // 幂等键
    "X-SuperAgent-Forward-EXPERIENCE-IMPROVEMENT": "true|false"
  }
})
```

SDK 映射到 `POST /session/{sessionID}/message`，query 里带 `directory` / `workspace`。
主进程的 `webRequest.onBeforeSendHeaders` 还会给所有 `127.0.0.1` / `localhost` 请求补上：

| 头 | 值 | 作用 | 证据 |
|---|---|---|---|
| `Authorization` | `Basic super-agent:<随机密码>` | 本机引擎的 Basic 鉴权 | `[代码]` `fRe()` |
| `X-SA-Sign-Version` | `local-v1` | 本机请求签名版本 | `[代码]` `LocalAuthService`；`[二进制]` `X-SA-Sign-Version` |
| `X-SA-Timestamp` | 毫秒 | 本机签名时间戳（**毫秒**） | `[代码]` |
| `X-SA-Nonce` | 12 字节 hex | 本机签名一次性随机数 | `[代码]` |
| `X-SA-Signature` | HMAC-SHA256(base64url) | 本机请求签名，密钥来自 `SUPER_AGENT_LOCAL_SESSION_KEY` | `[代码]` + `[二进制]` `local_auth_*` |
| `X-Device-OS` / `X-Device-OS-Version` | 系统信息 | 设备信息 | `[代码]` `cBe()` |
| `X-Token` | 用户 JWT | 本机请求也带（便于引擎归因） | `[代码]` `cBe()` |
| `x-opencode-directory` / `x-opencode-workspace` | URL 编码路径 | 工作区路由 | `[代码]` |

## 2. 引擎 → 上游网关（真正的对话请求）

### 2.1 主请求

```
POST https://agent.teleai.com.cn/superCowork/sapi/api/v1/chat/completions
```

`[代码]` 主进程给引擎的 provider 配置：`baseURL = https://agent.teleai.com.cn/superCowork/sapi/api/v1`，
`npm = @ai-sdk/openai-compatible`，SDK 追加 `/chat/completions`。
`[二进制]` 引擎同时含 `/chat/completions` 与 `/v1/chat/completions` 两个 SDK 路径模板。
`[实测]` 同一路径用浏览器 token + `superagent-auth-v1` 签名，流式/非流式都返回 200。

### 2.2 请求头

| 头 | 来源 | 作用 | 证据 |
|---|---|---|---|
| `X-Token` | `SUPER_AGENT_AUTH_STATE` 里的用户 JWT | 用户身份（唯一用户凭据） | `[二进制]`；`[代码]` 加密注入 |
| `X-SuperAgent-Timestamp` | 引擎生成，**秒** | 签名时间戳 / 防重放窗口 | `[二进制]` + `[实测]` |
| `X-SuperAgent-Nonce` | 引擎生成，UUID | 签名一次性随机数 | `[二进制]` + `[实测]` |
| `X-SuperAgent-Sign-Version` | 固定 `v1` | 指定 `superagent-auth-v1` 签名方案 | `[二进制]` + `[实测]` |
| `X-SuperAgent-Signature` | HMAC-SHA256（hex） | 请求签名，覆盖 method/path/ts/nonce/version/body-SHA256 | `[二进制]` + `[实测]` |
| `X-SuperAgent-Device-Id` | 设备标识（12 位 hex） | 设备身份 | `[二进制]` + `[代码]` device-meta |
| `X-SuperAgent-Install-Id` | 安装标识（UUID） | 安装身份 | `[二进制]` + `[代码]` device-meta |
| `X-App-Version` | `SUPER_AGENT_APP_VERSION` = `3.0.1` | 客户端版本 | `[二进制]` `[代码]` |
| `X-Route-Target` | 主进程 provider 配置 `headers: { "X-Route-Target": "ops-gateway" }` | 网关路由到 ops-gateway | `[代码]` `TBe`；`[二进制]` 无此字符串（来自配置） |
| `X-TeleAI-Client-Type` | `OPENCODE_CLIENT` 环境变量 | **usage 归因**（asar 注释原文） | `[代码]` 注释；`[二进制]` |
| `X-TeleAI-Query-ID` | renderer 的 `queryId` 透传 | 把一次上游调用关联到用户这次提问（用量/计费） | `[二进制]`；`[推断]` 值来自 sendMessage |
| `X-TeleAI-Root-Session-ID` | 根会话 id | 子代理/子任务归属到根会话 | `[二进制]` |
| `X-TeleAI-Run-Unit-Type` / `X-TeleAI-Run-Unit-ID` | 引擎运行单元 | 标明这次执行属于哪种 run unit | `[二进制]` |
| `X-TeleAI-Upstream-Request-ID` | 引擎生成 | 上游请求链路 id | `[二进制]` |
| `Authorization` | provider 配置里的 `apiKey`（`sk-qvp4m…`） | OpenAI 兼容 SDK 的渠道标识；上游**不强制**（实测不带也 200） | `[代码]` `OUt.NewApi.options.apiKey`；`[实测]` |
| `User-Agent` | 固定 | 引擎标识 | `[二进制]` `super-agent-go/1.0` |
| `Content-Type` / `Accept` | 固定 | `application/json` / `text/event-stream` | `[代码]` |
| `X-Session-ID` / `X-Message-ID` / `X-Request-ID` | 引擎生成 | 链路关联 | `[二进制]` |

> ⚠️ 没有抓到桌面端这次聊天请求的 TLS 明文。上表的**名字**全部来自引擎二进制，
> **签名算法**已用真实 token 对上游验证（只带 X-Token → `40104`；按此签名 → 200），
> `X-Route-Target` 来自主进程 provider 配置而不是引擎硬编码；`Authorization` 按 SDK 行为推断，
> 实测上游不依赖它。

### 2.3 条件请求（不是每轮都有）

| 方法 | 路径 | 触发条件 | 证据 |
|---|---|---|---|
| POST | `/superCowork/sapi/api/v1/coworker/web_search` | 模型调用 web search 工具（默认工具策略里 websearch 是 `deny`） | `[二进制]` |
| POST | `/superCowork/sapi/api/v1/security/instruction/review` | 指令安全审核（引擎侧；`SUPER_AGENT_INSTRUCTION_REVIEW_APP_ID` 非空时） | `[二进制]` + `[代码]` 环境变量 |
| POST | `/superCowork/sapi/api/v1/image-generation-pro` | 使用图像生成档位 | `[二进制]` |
| POST | `/superCowork/sapi/api/v1/check/content` | 内容审核：`{content, checkType:"text"|"image", contentType:"userQuery"|"modelOutput", sessionId?, messageId?}`；失败按策略放行 | `[代码]` endpoint 表 + `$U`/`uBe` |
| POST | `/superCowork/sapi/api/v1/security/instruction/ask_review` | “询问”类安全审核 | `[代码]` endpoint 表 |
| POST | `/superCowork/sapi/api/v1/usage/sync` | **每条 assistant 消息后**上报 token 用量；失败重试并落 pending | `[代码]` `EWe`/`TWe` |
| GET | `/superCowork/sapi/api/v1/user-snapshot?userId=&date=` | usage sync 成功后的基线刷新 | `[代码]` `qy()` |
| POST | `/superCowork/sapi/api/v1/usage/token-records` | 用量页查询（不是每轮对话） | `[代码]` |
| POST | `/teleagent-filecenter/v1/files/pre-upload`、`/upload` | 发送附件前上传 | `[代码]` endpoint 表 |
| POST | `/superCowork/sapi/cowork/auth/token-refresh` | token 续期：空 body；头 `X-Token` / `X-Timestamp` / `X-Nonce` / `X-App-Version` / `X-OS-Type` / `X-SuperAgent-Device-Id`；响应 `accessToken` / `expiresIn` / `absoluteExpiresAt` | `[代码]` 主进程 renewal；`[实测]` 无效 token 401 `4001` |
| POST | `/superCowork/sapi/api/v1/analytics/events` | 遥测/埋点 | `[代码]` |

## 3. 一次对话的实际顺序

1. 启动时 `GET /global/event` 订阅 SSE（`[日志]`）。
2. 新建/选择会话：`POST /session` 或 `GET /session`（`[代码]`/`[日志]`）。
3. 用户点发送：
   - 可能先 `POST /api/v1/check/content` 审核输入（按策略）；
   - `POST /session/{id}/message`（本机引擎，带 `idempotency-key` 等）；
4. 引擎：
   - 可能 `POST /api/v1/security/instruction/review`（指令审核）；
   - `POST /api/v1/chat/completions`（真正的 LLM 调用，签名头）；
   - 需要工具时 `POST /api/v1/coworker/web_search` 等；
5. 引擎把增量写进 `/global/event`（`message.part.delta`…），renderer 渲染；
6. 一轮结束后 renderer `POST /api/v1/usage/sync`，成功后 `GET /api/v1/user-snapshot`；
7. 停止时 `POST /session/{id}/abort`。

## 4. 未确认/未抓到的部分

- TLS 明文：没有在桌面端与上游之间做中间人抓包；头部集合来自二进制与配置。
- `X-TeleAI-*` 的具体触发条件：名字与所在包已确认，但哪些是每轮都带、哪些只在子代理/工具调用时带，未逐项抓包验证。
- 内容审核与指令审核是否对当前账号开启：取决于服务端策略与设置，代码是 fail-open。
- 云会话（AIS/云电脑）走的是另一套 Connect RPC（`ais.session.*`），不在本地引擎 REST 路径里；本文只覆盖本机对话。
