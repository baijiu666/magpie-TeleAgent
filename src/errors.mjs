// 错误语义：每个出口都带 status + code + 可读的 message。
// 401 表示账号要重新登录；403 是套餐/额度，不能因此停用账号。

export const CODES = Object.freeze({
  signInRequired: "sign_in_required",
  sessionExpired: "session_expired",
  invalidRequest: "invalid_request",
  modelNotFound: "model_not_found",
  rateLimited: "rate_limited",
  upstreamUnavailable: "upstream_unavailable",
  upstreamTimeout: "upstream_timeout",
  upstreamError: "upstream_error",
  signingError: "signing_error",
  internalError: "internal_error",
  notImplemented: "not_implemented",
})

export class ApiError extends Error {
  constructor(message, { status = 0, code = "", internal = false } = {}) {
    super(String(message ?? ""))
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.internal = internal
  }
}

export function errorResponse(status, code, message, headers = {}) {
  return new Response(
    JSON.stringify({
      error: { message: String(message ?? ""), type: "upstream_error", code, status },
    }),
    { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } },
  )
}

export function asApiError(error) {
  if (error instanceof ApiError) return error
  const message = error?.message ?? String(error ?? "插件内部错误")
  if (error?.name === "AbortError" || error?.name === "TimeoutError") {
    return new ApiError(`上游等待超时：${message}`, { status: 504, code: CODES.upstreamTimeout })
  }
  return new ApiError(message, { status: 502, code: CODES.internalError, internal: true })
}
