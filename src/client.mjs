// 与上游的 HTTP 层：签名、两套业务头、GET 解析、对话 POST。

import { createHash, createHmac, randomUUID } from "node:crypto"

import {
  BASE,
  CLIENT_UA,
  CLIENT_VERSION,
  PATHS,
  REQUEST_TIMEOUT,
  ROUTE_TARGET,
  SIGN_PREFIX,
  SIGN_VERSION,
} from "./provider.mjs"
import { ApiError, CODES } from "./errors.mjs"
import { jwtParts } from "./auth.mjs"

const sha256Hex = (text) => createHash("sha256").update(text).digest("hex")
const hmacHex = (key, text) => createHmac("sha256", key).update(text).digest("hex")

/**
 * `superagent-auth-v1` 的规范串（签名测试锁这个格式）：
 *   derivedKey = HMAC(jwt 第三段, "superagent-auth-v1/{token}/{installId}/{ts}/{nonce}")
 *   request    = "superagent-auth-v1\n{METHOD}\n{path?query}\n{ts}\n{nonce}\n{version}\n{sha256(body)}"
 *   signature  = HMAC(derivedKey, request)  // hex
 */
export function canonicalRequest({ method, pathWithQuery, body, timestamp, nonce }) {
  return [
    SIGN_PREFIX,
    String(method).toUpperCase(),
    pathWithQuery,
    timestamp,
    nonce,
    CLIENT_VERSION,
    sha256Hex(body),
  ].join("\n")
}

export function derivedKey({ token, installId, timestamp, nonce }) {
  const parts = jwtParts(token)
  if (parts.length !== 3 || !parts[2]) {
    throw new ApiError("token 不是三段式 JWT，无法生成签名", { status: 401, code: CODES.signInRequired })
  }
  return hmacHex(parts[2], [SIGN_PREFIX, token, installId, timestamp, nonce].join("/"))
}

/** 推理头：身份 + 签名（时间戳秒级，nonce UUID） */
export function signedHeaders({ token, deviceId, installId, method, pathWithQuery, body, nowMs = Date.now(), nonce = randomUUID() }) {
  const timestamp = String(Math.floor(nowMs / 1000))
  const key = derivedKey({ token, installId, timestamp, nonce })
  const signature = hmacHex(key, canonicalRequest({ method, pathWithQuery, body, timestamp, nonce }))

  return {
    "X-Token": token,
    "X-Route-Target": ROUTE_TARGET,
    "X-App-Version": CLIENT_VERSION,
    "X-SuperAgent-Device-Id": deviceId,
    "X-SuperAgent-Install-Id": installId,
    "X-SuperAgent-Timestamp": timestamp,
    "X-SuperAgent-Nonce": nonce,
    "X-SuperAgent-Sign-Version": SIGN_VERSION,
    "X-SuperAgent-Signature": signature,
  }
}

/**
 * 业务头：两套一起发。
 * userCenter / points/detail 认 `X-SuperAgent-*`；`/api/v1/model-options`
 * 还要渲染进程那套 `X-Timestamp` / `X-Nonce` / `X-OS-Type`，少一个就 40101。
 */
export function businessHeaders({ token, deviceId, installId, nowMs = Date.now(), nonce = randomUUID() }) {
  const seconds = String(Math.floor(nowMs / 1000))
  return {
    "X-Token": token,
    "X-Route-Target": ROUTE_TARGET,
    "X-App-Version": CLIENT_VERSION,
    "X-SuperAgent-Timestamp": seconds,
    "X-SuperAgent-Nonce": nonce,
    "X-SuperAgent-Device-Id": deviceId,
    "X-SuperAgent-Install-Id": installId,
    "X-Timestamp": seconds,
    "X-Nonce": nonce,
    "X-OS-Type": process.platform,
    "X-Channel-Id": "",
    "X-Runtime-Env": "",
    "User-Agent": CLIENT_UA,
    Accept: "application/json",
  }
}

/** 业务 GET：返回 { status, json, text, contentType }，不做业务判断 */
export async function getJson(pathWithQuery, { token, identity, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT }) {
  const response = await fetchImpl(`${BASE}${pathWithQuery}`, {
    method: "GET",
    headers: businessHeaders({ token, ...identity }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  const contentType = String(response.headers.get("content-type") ?? "")
  let json
  try {
    json = text ? JSON.parse(text) : undefined
  } catch {
    json = undefined
  }
  return { status: response.status, json, text, contentType }
}

/**
 * 业务信封：`code` ∈ {0,200} 或 `success:true` 取 `data`。
 * 401/403 与「200 + 登录页 HTML」都判成登录失效。
 */
export function unwrapBusiness(result, what) {
  if (result.status === 401 || result.status === 403) {
    throw new ApiError(`${what}失败：登录已失效（HTTP ${result.status}），请重新登录`, {
      status: 401,
      code: CODES.sessionExpired,
    })
  }
  if (!/json/i.test(result.contentType) || result.json === undefined) {
    throw new ApiError(`${what}失败：上游返回了非 JSON 响应（HTTP ${result.status}），token 可能已失效`, {
      status: 401,
      code: CODES.sessionExpired,
    })
  }
  const envelope = result.json
  if (envelope && typeof envelope === "object") {
    const code = String(envelope.code ?? "")
    if (code && code !== "0" && code !== "200" && envelope.success !== true) {
      throw new ApiError(
        `${what}失败：上游 code=${code} ${envelope.message ?? envelope.msg ?? ""}`.trim(),
        { status: 502, code: CODES.upstreamError },
      )
    }
  }
  const data = envelope?.data
  return data !== null && typeof data === "object" && !Array.isArray(data) ? data : envelope
}

/** 账号资料（登录校验 + 卡片名字） */
export async function fetchUserInfo(token, identity, { fetchImpl = fetch } = {}) {
  const data = unwrapBusiness(
    await getJson(PATHS.userInfo, { token, identity, fetchImpl }),
    "读取账号信息",
  )
  return {
    accountId: String(data?.accountId ?? data?.account_id ?? "").trim(),
    accountName: String(data?.accountName ?? data?.account_name ?? data?.nickname ?? "").trim(),
    phone: String(data?.phone ?? data?.mobile ?? "").trim(),
  }
}

/**
 * 续期：POST /cowork/auth/token-refresh。
 * 桌面端契约：body 为空；X-Token 是当前 token；响应 data.{accessToken,expiresIn,absoluteExpiresAt}。
 * 401/40112-40116 是终止态（要重新登录）；404/405 是旧服务端没有这个端点。
 */
export async function refreshAccessToken(token, identity, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const now = Date.now()
  const response = await fetchImpl(`${BASE}${PATHS.tokenRefresh}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Token": token,
      "X-Timestamp": String(Math.floor(now / 1000)),
      "X-Nonce": randomUUID(),
      "X-App-Version": CLIENT_VERSION,
      "X-OS-Type": process.platform,
      "X-SuperAgent-Device-Id": identity.deviceId,
      "User-Agent": CLIENT_UA,
    },
    body: "",
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  let json
  try { json = text ? JSON.parse(text) : undefined } catch { json = undefined }

  const code = Number(json?.code ?? json?.responseCode ?? json?.data?.code)
  const terminal = [40112, 40113, 40114, 40115, 40116]
  const message = String(json?.message ?? json?.msg ?? text ?? "").slice(0, 200) || "续期失败"

  if (terminal.includes(code) || response.status === 401) {
    throw new ApiError(`token 续期失败：${message}`, { status: 401, code: CODES.sessionExpired })
  }
  if (response.status === 404 || response.status === 405) {
    throw new ApiError(`续期端点不存在（HTTP ${response.status}）`, { status: response.status, code: CODES.notImplemented })
  }
  if (!response.ok) {
    const status = response.status >= 500 || code === 50005 ? 503 : 502
    throw new ApiError(`token 续期失败：${message}`, {
      status,
      code: status === 503 ? CODES.upstreamUnavailable : CODES.upstreamError,
    })
  }

  const data = json?.data && typeof json.data === "object" ? json.data : json
  const access = String(data?.accessToken ?? data?.access_token ?? data?.token ?? "").trim()
  const expiresIn = Number(data?.expiresIn ?? data?.expires_in ?? json?.expiresIn ?? json?.expires_in)
  if (!access || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new ApiError("token 续期响应缺少 accessToken/expiresIn", { status: 502, code: CODES.upstreamError })
  }
  return { access, expires: now + expiresIn * 1000, ttlMs: expiresIn * 1000 }
}

/** 对话 POST（签名 + 消息/会话 id） */
export function postChat({ url, token, identity, body, stream, signal, fetchImpl = fetch }) {
  const target = new URL(url)
  const headers = {
    ...signedHeaders({
      token,
      deviceId: identity.deviceId,
      installId: identity.installId,
      method: "POST",
      pathWithQuery: `${target.pathname}${target.search}`,
      body,
    }),
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
    "User-Agent": CLIENT_UA,
    "x-message-id": `msg_${randomUUID().replace(/-/gu, "")}`,
    "x-session-id": `ses_${randomUUID().replace(/-/gu, "")}`,
  }
  return fetchImpl(target.toString(), { method: "POST", headers, body, signal })
}

