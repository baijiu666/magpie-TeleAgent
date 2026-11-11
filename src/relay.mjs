// 对话通道：清洗请求体、透传响应、把上游错误整理成 OpenAI 形状。

import { CHAT_TIMEOUT, MAX_OUTPUT, fallbackModels } from "./provider.mjs"
import { ApiError, CODES, asApiError, errorResponse } from "./errors.mjs"
import { postChat } from "./client.mjs"

// 上游只认基础字段（外加 reasoning_effort），多一个整包拒绝。
const ALLOWED = new Set([
  "model",
  "messages",
  "stream",
  "temperature",
  "top_p",
  "max_tokens",
  "tools",
  "tool_choice",
  // 上游接受：low 能显著缩短/关闭思维链（实测 reasoning_tokens 归零）
  "reasoning_effort",
])

/** 白名单 + `max_completion_tokens` 改名 + `max_tokens` 封顶 */
export function sanitizeChatBody(text, { reasoningEffort } = {}) {
  let raw
  try {
    raw = text ? JSON.parse(text) : {}
  } catch {
    throw new ApiError(`请求体不是合法 JSON：${String(text).slice(0, 200)}`, {
      status: 400,
      code: CODES.invalidRequest,
    })
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return text

  const cleaned = {}
  for (const [key, value] of Object.entries(raw)) {
    if (ALLOWED.has(key)) cleaned[key] = value
    else if (key === "max_completion_tokens" && cleaned.max_tokens === undefined) cleaned.max_tokens = value
  }
  if (typeof cleaned.max_tokens === "number" && cleaned.max_tokens > MAX_OUTPUT) {
    cleaned.max_tokens = MAX_OUTPUT
  }
  // 插件级默认思考档位；调用方显式传的 reasoning_effort 优先
  if (reasoningEffort && cleaned.reasoning_effort === undefined) {
    cleaned.reasoning_effort = reasoningEffort
  }
  return JSON.stringify(cleaned)
}

/** 有的客户端会把 max_tokens 设得比上游上限还大 */
export function isEmptyCompletion(text) {
  try {
    const choices = JSON.parse(text)?.choices
    if (!Array.isArray(choices) || choices.length === 0) return true
    return choices.every((choice) => {
      const message = choice?.message ?? {}
      return (
        !message.content
        && !message.reasoning_content
        && !(Array.isArray(message.tool_calls) && message.tool_calls.length > 0)
      )
    })
  } catch {
    return false
  }
}

/** 40301/40104/40101 都是签名或头的问题，不是账号过期 */
export function isSigningError(json) {
  return ["40301", "40104", "40101"].includes(String(json?.code ?? ""))
}

function upstreamMessage(json, text) {
  const value = json?.message ?? json?.msg ?? json?.error?.message
  if (typeof value === "string" && value.trim()) return value.trim()
  return String(text ?? "").trim().slice(0, 300) || "上游没有给出错误信息"
}

function codeForStatus(status) {
  if (status === 400) return CODES.invalidRequest
  if (status === 401) return CODES.sessionExpired
  if (status === 404) return CODES.modelNotFound
  if (status === 429) return CODES.rateLimited
  if (status === 503) return CODES.upstreamUnavailable
  if (status === 504) return CODES.upstreamTimeout
  return CODES.upstreamError
}

/** 本地 /models（agent 有时会探），不打上游 */
export function modelsResponse(entries = fallbackModels()) {
  return new Response(
    JSON.stringify({
      object: "list",
      data: Object.values(entries).map((m) => ({
        id: m.id,
        object: "model",
        created: 0,
        owned_by: "teleagent",
        name: m.name,
      })),
    }),
    { status: 200, headers: { "content-type": "application/json; charset=utf-8" } },
  )
}

/** 上游响应 → 客户端 Response */
export async function toClientResponse(response) {
  const contentType = String(response.headers.get("content-type") ?? "")

  if (!response.ok) {
    const text = await response.text()
    let json
    try {
      json = text ? JSON.parse(text) : undefined
    } catch {
      json = undefined
    }
    if (isSigningError(json)) {
      return errorResponse(
        401,
        CODES.signingError,
        `${upstreamMessage(json, text)}（签名与上游不一致，不是账号问题）`,
        { "X-Magpie-Sign-In": "kept" },
      )
    }
    const status = Number(response.status) || 502
    if (/html/i.test(contentType)) {
      return errorResponse(status, CODES.upstreamUnavailable, `上游返回了 HTML 错误页（HTTP ${status}）`)
    }
    return errorResponse(
      status,
      codeForStatus(status),
      upstreamMessage(json, text),
      status === 403 ? { "X-Magpie-Sign-In": "kept" } : {},
    )
  }

  if (/html/i.test(contentType)) {
    return errorResponse(401, CODES.sessionExpired, "token 已失效（上游返回登录页），请重新登录")
  }

  const headers = new Headers(response.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  if (/event-stream/i.test(contentType)) {
    return new Response(response.body, { status: response.status, headers })
  }
  return new Response(await response.text(), { status: response.status, headers })
}

/** 整轮对话：非流式空响应重试一次；流式直接透传 */
export async function relayChat({ url, token, identity, body, stream, signal, fetchImpl = fetch }) {
  const send = () => postChat({ url, token, identity, body, stream, signal, fetchImpl })

  const response = await send()
  if (stream || !response.ok) return toClientResponse(response)

  const text = await response.text()
  if (/html/i.test(String(response.headers.get("content-type") ?? "")) || !isEmptyCompletion(text)) {
    return toClientResponse(new Response(text, { status: response.status, headers: response.headers }))
  }

  const retried = await send()
  if (!retried.ok) return toClientResponse(retried)
  const again = await retried.text()
  if (/html/i.test(String(retried.headers.get("content-type") ?? "")) || !isEmptyCompletion(again)) {
    return toClientResponse(new Response(again, { status: retried.status, headers: retried.headers }))
  }
  return errorResponse(503, CODES.upstreamUnavailable, "上游连续两次返回空响应，请稍后重试")
}

export function chatSignal(signal) {
  const signals = [AbortSignal.timeout(CHAT_TIMEOUT)]
  if (signal) signals.push(signal)
  return signals.length > 1 ? AbortSignal.any(signals) : signals[0]
}

export function errorToResponse(error) {
  const err = asApiError(error)
  return errorResponse(err.status || 502, err.code || CODES.upstreamError, err.message, {
    ...(err.code === CODES.signingError ? { "X-Magpie-Sign-In": "kept" } : {}),
  })
}
