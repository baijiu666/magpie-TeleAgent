// 3.0.1 的固定事实：地址、版本、端点、模型兜底表。
// 来源只有两处：本机安装包（D:\TeleAgent\resources\app.asar）与对上游的真机实测。

export const PROVIDER = "teleagent"
export const PROVIDER_NAME = "TeleAgent 星辰超级智能体"

export const ORIGIN = "https://agent.teleai.com.cn"
export const BASE = `${ORIGIN}/superCowork/sapi`
export const API = `${BASE}/api/v1`

// Web 登录入口：登录 app 自己轮询 callback/redirect，完成后跳 /teleagent 并写 operationToken cookie。
export const LOGIN_URL = `${ORIGIN}/meter/teleagent-login/middle?redirect_url=${encodeURIComponent(`${ORIGIN}/teleagent`)}`

export const SDK = "@ai-sdk/openai-compatible"
export const CLIENT_VERSION = "3.0.1"
// 上游按 UA 认客户端；这个串是官方引擎的默认值。
export const CLIENT_UA = "opencode/1.2.27 ai-sdk/provider-utils/3.0.20 runtime/bun/1.3.10"
export const ROUTE_TARGET = "ops-gateway"

export const SIGN_PREFIX = "superagent-auth-v1"
export const SIGN_VERSION = "v1"

export const PATHS = Object.freeze({
  userInfo: "/cowork/user_info",
  points: "/user/portal/companyStore/userCenter",
  pointsDetail: "/user/portal/points/detail",
  welfare: "/user/portal/companyStore/v3/checkDayTask",
  models: "/api/v1/model-options",
  tokenRefresh: "/cowork/auth/token-refresh",
})

// 目录接口的 context_limit 实测恒 null：窗口与输出由客户端按预置配置补齐。
export const CONTEXT_WINDOW = 400_000
export const MAX_OUTPUT = 65_536

export const REQUEST_TIMEOUT = 30_000
// 官方桌面端给单轮 20 分钟；这里取 10 分钟，够长代码/推理任务，又不至于无限挂
export const CHAT_TIMEOUT = 600_000

/** 并发任务上限的兜底：官方账号中心 `max_concurrent_tasks` 取不到时用它 */
export const DEFAULT_MAX_CONCURRENCY = 3

/** token 续期返回的 TTL 实测约 7 天；没有拿到 TTL 时按它估算 refreshLead */
export const DEFAULT_TTL_MS = 7 * 24 * 3600_000

export const ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjggMTI4Ij48cmVjdCB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgcng9IjI4IiBmaWxsPSIjMDA2OGI3Ii8+PHBhdGggZD0iTTY0IDI0bDkuMiAyMi44TDk2IDU2bC0yMi44IDkuMkw2NCA4OGwtOS4yLTIyLjhMMzIgNTZsMjIuOC05LjJ6IiBmaWxsPSIjZmZmIi8+PGNpcmNsZSBjeD0iNjQiIGN5PSI2NCIgcj0iNDciIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLW9wYWNpdHk9Ii4zNSIgc3Ryb2tlLXdpZHRoPSIzIi8+PC9zdmc+"

/**
 * 支持图片输入的模型（2026-11-11 真机实测；目录接口没有 modality 字段）：
 * chat-pro / chat-flash 能读图（prompt_tokens 明显包含图像），chat-flagship 明确回「无法处理图片」。
 */
export const VISION_MODELS = Object.freeze(["chat-pro", "chat-flash"])

/** 模型条目（magpie 的 provider.models / config 共用） */
export function modelEntry({ id, name, rate, description, context = CONTEXT_WINDOW, output = MAX_OUTPUT, isDefault = false, vision = false }) {
  return {
    id,
    name: name || id,
    api: { id, url: API, npm: SDK },
    status: "active",
    limit: { context, output },
    ...(rate ? { rate } : {}),
    ...(isDefault ? { default: true } : {}),
    ...(description ? { description } : {}),
    modalities: { input: vision ? ["text", "image"] : ["text"], output: ["text"] },
    attachment: vision,
    tool_call: true,
    capabilities: {
      temperature: true,
      reasoning: false,
      toolcall: true,
      attachment: vision,
      input: { text: true, image: vision, audio: false, video: false, pdf: false },
      output: { text: true },
    },
  }
}

/** 未登录 / 目录失败时的兜底：与 3.0.1 在售目录一致 */
export function fallbackModels(contextLength = CONTEXT_WINDOW) {
  return {
    "chat-pro": modelEntry({ id: "chat-pro", name: "智能", rate: "x0.6", isDefault: true, context: contextLength, vision: VISION_MODELS.includes("chat-pro") }),
    "chat-flagship": modelEntry({ id: "chat-flagship", name: "旗舰", rate: "x1.0", context: contextLength, vision: VISION_MODELS.includes("chat-flagship") }),
    "chat-flash": modelEntry({ id: "chat-flash", name: "极速", rate: "x0.2", context: contextLength, vision: VISION_MODELS.includes("chat-flash") }),
  }
}
