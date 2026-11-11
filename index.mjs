// magpie 插件入口：只做装配，协议实现在 src/。
//
// 上游是 TeleAgent 桌面端（星辰超级智能体 / 中国电信天翼 AI）的私有后端：
//   · 用户身份走 X-Token；推理还要 superagent-auth-v1 签名
//   · 模型目录有公开端点，积分是带到期时间的包，签到是活动 + jump_url
//   · 有 /cowork/auth/token-refresh：refresh() 自动续期，优先采纳桌面端已续期的 token

import {
  API,
  ICON,
  LOGIN_URL,
  PROVIDER,
  PROVIDER_NAME,
  SDK,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_TTL_MS,
  fallbackModels,
} from "./src/provider.mjs"
import { ApiError, CODES, errorResponse } from "./src/errors.mjs"
import {
  accountKey,
  deviceIdentity,
  identityOfAuth,
  importLocalToken,
  readDesktopContextLength,
  readDesktopDeviceMeta,
  jwtPayload,
  DEFAULT_CONTEXT_LENGTH,
  tokenExpiresAt,
} from "./src/auth.mjs"
import { fetchUserInfo, refreshAccessToken } from "./src/client.mjs"
import {
  claimActivity,
  dailyActivity,
  fetchPackages,
  fetchPoints,
  fetchWelfare,
  formatPoints,
  isClaimable,
} from "./src/benefits.mjs"
import { fetchCatalog } from "./src/catalog.mjs"
import { chatSignal, errorToResponse, modelsResponse, relayChat, sanitizeChatBody } from "./src/relay.mjs"
import { chromiumLogin, findBrowser } from "./src/browser.mjs"

const USAGE_TTL = 60_000
const CATALOG_TTL = 10 * 60_000

/** 手机号打码（服务端没给昵称时用） */
function maskPhone(phone) {
  const text = String(phone ?? "").trim()
  if (!text || text.replace(/\D/gu, "").length < 7) return ""
  return `${text.slice(0, 3)}****${text.slice(-4)}`
}

/** token → magpie 登录态（会先打一次 user_info 验证）；来源只有浏览器 CDP / 本机桌面端 */
async function completeLogin(raw, fetchImpl) {
  const token = String(raw ?? "").trim()
  if (!token) throw new Error("登录凭据为空")

  const identity = deviceIdentity(accountKey(token))
  // 账号中心与卡片一致：并发上限来自 userCenter.max_concurrent_tasks
  const [profile, points] = await Promise.all([
    fetchUserInfo(token, identity, { fetchImpl }),
    fetchPoints({ token, identity, fetchImpl }).catch(() => undefined),
  ])
  const name = profile.accountName || maskPhone(profile.phone)
  const claims = jwtPayload(token)
  const ttlMs = claims?.iat && claims?.exp && claims.exp > claims.iat
    ? (claims.exp - claims.iat) * 1000
    : undefined

  return {
    type: "success",
    access: token,
    // magpie 需要 refresh 字段才落盘；空串 = 没有 refresh_token
    refresh: "",
    expires: tokenExpiresAt(token) ?? 0,
    accountId: name,
    uid: profile.accountId || accountKey(token),
    metadata: {
      ...(name ? { email: name } : {}),
      accountId: profile.accountId,
      deviceId: identity.deviceId,
      installId: identity.installId,
      ...(points?.maxConcurrentTasks ? { maxConcurrentTasks: points.maxConcurrentTasks } : {}),
      ...(points?.plan ? { plan: points.plan } : {}),
      ...(ttlMs ? { ttlMs } : {}),
    },
  }
}

export const TeleAgentPlugin = async (_ctx = {}, options = {}) => {
  const fetchImpl = typeof options?.fetch === "function" ? options.fetch : fetch
  // 插件选项：thinking 档位（网关实测只认 low / high / max）
  const defaultEffort = ["low", "high", "max"].includes(String(options?.reasoningEffort ?? ""))
    ? String(options.reasoningEffort)
    : ""
  // 桌面端「上下文长度」是用户可选项（200K/400K/600K/800K/1M），按账号存在 preset-context.json
  const desktopContext = () => {
    try { return readDesktopContextLength() } catch { return DEFAULT_CONTEXT_LENGTH }
  }

  const usageCache = new Map()
  const catalogCache = new Map()
  // 账号的并发上限：默认 3，取到账号值就更新（Magpie 通过 getter 读）
  let maxConcurrency = DEFAULT_MAX_CONCURRENCY
  const syncConcurrency = (auth) => {
    const n = Number(auth?.metadata?.maxConcurrentTasks)
    if (Number.isInteger(n) && n > 0) maxConcurrency = Math.min(n, 1000)
  }

  // 续期提前量按 token 实际寿命算（不是固定值）：一半寿命，最少 1 分钟、最多 24 小时
  let lastTtlMs = DEFAULT_TTL_MS
  const syncTtl = (auth) => {
    const fromMeta = Number(auth?.metadata?.ttlMs)
    if (Number.isFinite(fromMeta) && fromMeta > 0) { lastTtlMs = fromMeta; return }
    const p = jwtPayload(auth?.access)
    if (p?.iat && p?.exp && p.exp > p.iat) lastTtlMs = (p.exp - p.iat) * 1000
  }

  return {
    // ═══ ① provider ═══════════════════════════════════════════════════
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: PROVIDER_NAME,
        npm: SDK,
        api: API,
        models: fallbackModels(desktopContext()), // 未登录也要有内容，否则显示 0 models
        searches: false,
      }
    },

    auth: {
      provider: PROVIDER,
      icon: ICON,
      get maxConcurrency() {
        return maxConcurrency
      },
      // 续期提前量 = min(TOKEN 寿命 / 2, 24h)，最少 1 分钟；随登录/续期返回的 TTL 更新
      get refreshLead() {
        return Math.min(Math.max(Math.floor(lastTtlMs / 2), 60_000), 24 * 3600_000)
      },

      // ═══ ② 登录 ═════════════════════════════════════════════════════
      methods: [
        {
          type: "oauth",
          label: "浏览器登录（天翼账号）",
          async authorize() {
            const browser = findBrowser()
            if (!browser) {
              throw new Error(
                "没有找到 Chromium 内核浏览器（Chrome / Edge / Brave）。装一个，"
                + "或用 MAGPIE_TELEAGENT_BROWSER 指向它的 exe；"
                + "也可以改用「从本机 TeleAgent 客户端导入」。",
              )
            }
            const controller = new AbortController()
            const login = chromiumLogin({
              browser,
              url: LOGIN_URL,
              timeoutMs: 5 * 60_000,
              signal: controller.signal,
            })
            login.catch(() => {}) // 用户取消时没人 await，避免未处理拒绝
            return {
              url: LOGIN_URL,
              opened: true, // 浏览器已经由插件打开，magpie 不要再开一个
              method: "auto",
              instructions:
                "已打开一个临时浏览器窗口，请完成天翼账号登录；登录成功后会自动完成，"
                + "不需要复制任何东西。若窗口没打开，改用「从本机 TeleAgent 客户端导入」。",
              close: () => controller.abort(),
              async callback(_value, { signal } = {}) {
                const onAbort = () => controller.abort()
                signal?.addEventListener("abort", onAbort, { once: true })
                try {
                  return await completeLogin(await login, fetchImpl)
                } catch (error) {
                  return { type: "failed", error: String(error?.message ?? error) }
                } finally {
                  signal?.removeEventListener("abort", onAbort)
                  controller.abort()
                }
              },
            }
          },
        },

        {
          type: "oauth",
          label: "从本机 TeleAgent 客户端导入",
          async authorize() {
            // 读取与校验放 callback，authorize 立刻返回；importLocalToken 是同步的
            // （Windows 会起 PowerShell），不能在这里直接调用。
            const probe = Promise.resolve()
              .then(() => importLocalToken())
              .then((token) => completeLogin(token, fetchImpl))
            return {
              url: "",
              opened: true,
              method: "auto",
              instructions: "正在读取本机 TeleAgent 登录态…",
              async callback() {
                try {
                  return await probe
                } catch (error) {
                  return { type: "failed", error: String(error?.message ?? error) }
                }
              },
            }
          },
        },
      ],

      // ═══ ③ 续期 ═══════════════════════════════════════════════════
      // 3.0.1 有官方续期端点：POST /cowork/auth/token-refresh（空 body）。
      // 优先采纳桌面端自己续期后的新 token（不轮转，避免把桌面端顶掉）；没有再调端点。
      async refresh(auth) {
        if (!auth?.access) return undefined
        const identity = identityOfAuth(auth)
        const currentKey = accountKey(auth.access)
        const currentIat = jwtPayload(auth.access)?.iat ?? 0

        // 先看本机桌面端的登录态：同账号才用它的真实设备头
        let localToken = ""
        try { localToken = importLocalToken() } catch {}
        const localIsSameAccount = !!localToken && accountKey(localToken) === currentKey
        let renewalIdentity = identity
        if (localIsSameAccount) {
          try { renewalIdentity = readDesktopDeviceMeta() ?? identity } catch {}
        }

        // 1) 桌面端已经续期并写盘：采纳更新的同账号 token（不轮转）
        if (localIsSameAccount && localToken !== auth.access) {
          const localIat = jwtPayload(localToken)?.iat ?? 0
          if (localIat > currentIat) {
            try {
              await fetchUserInfo(localToken, renewalIdentity, { fetchImpl })
              const expires = tokenExpiresAt(localToken) ?? 0
              if (expires > Date.now()) lastTtlMs = expires - Date.now()
              return { access: localToken, expires }
            } catch {}
          }
        }

        // 2) 官方续期端点
        try {
          const renewed = await refreshAccessToken(auth.access, renewalIdentity, { fetchImpl })
          lastTtlMs = Math.max(60_000, renewed.ttlMs ?? (renewed.expires - Date.now()))
          return { access: renewed.access, expires: renewed.expires }
        } catch (error) {
          if (error instanceof ApiError && (error.status === 404 || error.status === 405)) {
            // 旧服务端没有续期端点：退回探测有效性
            try {
              await fetchUserInfo(auth.access, renewalIdentity, { fetchImpl })
              return undefined
            } catch (probeError) {
              if (probeError instanceof ApiError && probeError.status === 401) {
                throw Object.assign(new Error("TeleAgent 登录已失效，请重新登录"), { signIn: "expired" })
              }
              return undefined
            }
          }
          if (error instanceof ApiError && error.status === 401) {
            throw Object.assign(new Error("TeleAgent 登录已失效，请重新登录"), { signIn: "expired" })
          }
          // 网络 / 5xx / 403：保持旧 token，宿主会重试
          return undefined
        }
      },

      // ═══ ④ 对话 ═════════════════════════════════════════════════════
      async loader(getAuth) {
        const auth = await getAuth()
        if (!auth?.access) return {}
        syncConcurrency(auth)
        syncTtl(auth)

        return {
          baseURL: API,
          apiKey: "", // 用户身份只在 X-Token 里
          headers: { "user-agent": "magpie-teleagent" },

          async fetch(input, init) {
            const fresh = await getAuth()
            if (!fresh?.access) {
              throw new ApiError("登录已失效，请重新登录", { status: 401, code: CODES.sessionExpired })
            }

            const request = input instanceof Request ? input : null
            const url =
              typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.toString()
                  : (request?.url ?? "")
            const method = String(init?.method ?? request?.method ?? "GET").toUpperCase()

            if (/\/models\b/u.test(url) && method === "GET") {
              const ctx = desktopContext()
              const cacheKey = `${fresh.uid ?? fresh.accountId ?? fresh.access}|${ctx}`
              return modelsResponse(catalogCache.get(cacheKey)?.models ?? fallbackModels(ctx))
            }
            if (!/\/chat\/completions\b/u.test(url)) {
              return errorResponse(
                501,
                CODES.notImplemented,
                `该端点没有实现：${method} ${url}。本插件只提供 /chat/completions 与 /models。`,
              )
            }

            let text = ""
            if (typeof init?.body === "string") text = init.body
            else if (init?.body instanceof Uint8Array) text = new TextDecoder().decode(init.body)
            else if (init?.body && typeof init.body.getReader === "function") text = await new Response(init.body).text()
            else if (request) text = await request.text()

            try {
              const body = sanitizeChatBody(text, { reasoningEffort: defaultEffort })
              return await relayChat({
                url,
                token: fresh.access,
                identity: identityOfAuth(fresh),
                body,
                stream: JSON.parse(body)?.stream === true,
                signal: chatSignal(init?.signal ?? request?.signal),
                fetchImpl,
              })
            } catch (error) {
              return errorToResponse(error)
            }
          },
        }
      },

      // ═══ ⑤ 额度 ═════════════════════════════════════════════════════
      // 只给一条「积分」：卡片头部显示剩余，窗口里显示 已用 / 总量。
      async usage(getAuth) {
        const auth = await getAuth()
        if (!auth?.access) return { error: "未登录", windows: [] }
        syncConcurrency(auth)
        syncTtl(auth)

        const cacheKey = String(auth.uid ?? auth.accountId ?? auth.access).slice(-64)
        const cached = usageCache.get(cacheKey)
        if (cached && Date.now() - cached.at < USAGE_TTL) return cached.value

        try {
          const identity = identityOfAuth(auth)
          const [points, detail] = await Promise.all([
            fetchPoints({ token: auth.access, identity, fetchImpl }).catch(() => undefined),
            fetchPackages({ token: auth.access, identity, fetchImpl }).catch(() => undefined),
          ])

          const packages = (detail?.packages ?? []).filter((p) => !p.expired && p.totalQuota > 0)
          const totalQuota = packages.reduce((sum, p) => sum + p.totalQuota, 0)
          const usedQuota = packages.reduce((sum, p) => sum + p.usedQuota, 0)
          const balance = detail?.balance ?? points?.balance

          const windows = []
          if (totalQuota > 0) {
            windows.push({
              name: "积分",
              used: Math.max(0, (usedQuota / totalQuota) * 100),
              amount: usedQuota,
              limit: totalQuota,
              unit: "积分",
              display: `${formatPoints(balance ?? totalQuota - usedQuota)} / ${formatPoints(totalQuota)} 积分`,
            })
          } else if (balance !== undefined) {
            windows.push({
              name: "积分",
              used: 0,
              aside: true,
              unit: "积分",
              display: `${formatPoints(balance)} 积分`,
            })
          }

          if (points?.maxConcurrentTasks) maxConcurrency = Math.min(points.maxConcurrentTasks, 1000)
          const value = {
            ...(auth.accountId ? { user: String(auth.accountId) } : {}),
            ...(points?.plan ? { plan: points.plan } : {}),
            windows,
          }
          usageCache.set(cacheKey, { at: Date.now(), value })
          return value
        } catch (error) {
          usageCache.delete(cacheKey)
          if (error instanceof ApiError && error.status === 401) {
            return { error: "登录已失效，请重新登录", windows: [] }
          }
          return { error: String(error?.message ?? error), windows: [] }
        }
      },

      // ═══ ⑥ 签到（只在用量详情里出现，账号卡片不显示） ═════════════
      async checkin(getAuth) {
        const auth = await getAuth()
        if (!auth?.access) return { outcome: "failed", message: "未登录" }

        try {
          const identity = identityOfAuth(auth)
          const welfare = await fetchWelfare({ token: auth.access, identity, fetchImpl }).catch(() => undefined)
          if (!welfare) return { outcome: "failed", message: "读取积分福利社失败，请稍后重试" }

          const activity = dailyActivity(welfare)
          const status = String(activity?.action_status ?? "")
          if (!activity) return { outcome: "inactive", message: "当前账号没有「积分福利社」每日签到" }
          if (status === "completed") return { outcome: "claimed", message: "今日已签到" }
          if (!isClaimable(activity)) {
            return { outcome: "inactive", message: `当前没有可领取的签到（status=${status || "未知"}）` }
          }

          const before = await fetchPackages({ token: auth.access, identity, fetchImpl })
            .then((d) => d.balance)
            .catch(() => undefined)
          await claimActivity(activity, { token: auth.access, identity, fetchImpl })
          const after = await fetchPackages({ token: auth.access, identity, fetchImpl })
            .then((d) => d.balance)
            .catch(() => undefined)
          const credit =
            Number.isFinite(before) && Number.isFinite(after) && after > before ? after - before : undefined

          const welfareAfter = await fetchWelfare({ token: auth.access, identity, fetchImpl }).catch(() => undefined)
          if (String(dailyActivity(welfareAfter)?.action_status ?? "") === "completed") {
            return { outcome: "claimed", ...(credit ? { credit } : {}), message: "签到成功，积分已到账" }
          }
          return {
            outcome: "failed",
            message: "领取请求已发送，但活动状态未变成 completed（服务端可能延迟或被拦截），请稍后重试",
          }
        } catch (error) {
          if (error instanceof ApiError && error.status === 401) {
            return { outcome: "failed", message: "登录已失效，请重新登录" }
          }
          return { outcome: "failed", message: String(error?.message ?? error) }
        }
      },

    },

    // ═══ ⑦ 每账号模型目录 ═══════════════════════════════════════════
    provider: {
      id: PROVIDER,
      async models(_fallback, { auth } = {}) {
        if (!auth?.access) return fallbackModels(desktopContext())
        syncConcurrency(auth)
        syncTtl(auth)

        const ctx = desktopContext()
        const cacheKey = `${auth.uid ?? auth.accountId ?? auth.access}|${ctx}`
        const cached = catalogCache.get(cacheKey)
        if (cached && Date.now() - cached.at < CATALOG_TTL) return cached.models

        try {
          const { models } = await fetchCatalog({
            token: auth.access,
            identity: identityOfAuth(auth),
            fetchImpl,
            contextLength: ctx,
          })
          catalogCache.set(cacheKey, { at: Date.now(), models })
          return models
        } catch {
          return cached?.models ?? fallbackModels(ctx)
        }
      },
    },
  }
}

// 入口只导出一个函数：多导出一个函数会被 magpie 当成第二个插件调
export const _internal = Object.freeze({ completeLogin, maskPhone })
