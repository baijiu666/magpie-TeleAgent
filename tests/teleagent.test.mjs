import assert from "node:assert/strict"
import test from "node:test"
import { createCipheriv, pbkdf2Sync } from "node:crypto"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  accountKey,
  deviceIdentity,
  identityOfAuth,
  jwtPayload,
  jwtParts,
  readDesktopContextLength,
  DEFAULT_CONTEXT_LENGTH,
  tokenExpiresAt,
  decryptLocalValue,
  decryptSafeStorage,
  decryptSafeStorageCbc,
  importLocalToken,
  readMasterKey,
  tokenFromRecord,
} from "../src/auth.mjs"
import { businessHeaders, canonicalRequest, derivedKey, refreshAccessToken, signedHeaders } from "../src/client.mjs"
import { isEmptyCompletion, isSigningError, sanitizeChatBody } from "../src/relay.mjs"
import { beijingIso, dailyPoints, fetchPackages, fetchPoints } from "../src/benefits.mjs"
import { fetchCatalog } from "../src/catalog.mjs"
import { decodeTokenValue, findBrowser, tokenFromCookies } from "../src/browser.mjs"
import { TeleAgentPlugin, _internal } from "../index.mjs"

/* 固定向量：用独立脚本按 README 的算法算出，锁住 canonical string 的格式 */
const VECTOR = Object.freeze({
  // 真实形态：`<tenant>:<JWT>`，冒号前缀只影响第一段，签名取第三段
  token:
    "Em9xR4:eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE3OTM4MDAwMDAsImFjY291bnRJZCI6ImFjY3QtMTIzIiwiYWNjb3VudE5hbWUiOiLmtYvor5XotKblj7cifQ.c2lnbmF0dXJlLXNlZ21lbnQ",
  installId: "11111111-2222-4333-8444-555555555555",
  deviceId: "0123456789ab",
  nowMs: 1793000000000,
  timestamp: "1793000000",
  nonce: "00000000-0000-4000-8000-000000000000",
  path: "/superCowork/sapi/api/v1/chat/completions",
  body: "{\"model\":\"chat-flash\",\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}],\"stream\":false}",
  derivedKey: "7ae1273e27ac6c0d13e0627084f450b32122cc15fd406d609d0d27362d1a21f2",
  signature: "60ce8a1889cc463d8808c18a4121ace71758d0659baa527630781b67c19bbbc3",
})

test("插件装配：config / 两个登录方式 / 五个 auth 钩子 / provider.models 齐备", async () => {
  const plugin = await TeleAgentPlugin({}, {})
  const cfg = {}
  await plugin.config(cfg)

  assert.equal(cfg.provider.teleagent.npm, "@ai-sdk/openai-compatible")
  assert.equal(cfg.provider.teleagent.models["chat-pro"].limit.output, 65_536)
  assert.equal(cfg.provider.teleagent.models["chat-pro"].limit.context, 400_000)
  assert.equal(cfg.provider.teleagent.models["chat-pro"].rate, "x0.6")
  assert.equal(cfg.provider.teleagent.models["chat-pro"].capabilities.toolcall, true)
  assert.equal(cfg.provider.teleagent.models["chat-pro"].capabilities.input.image, true)
  assert.equal(cfg.provider.teleagent.models["chat-flagship"].capabilities.input.image, false)
  assert.equal(cfg.provider.teleagent.models["chat-flash"].capabilities.input.image, true)

  assert.equal(plugin.auth.provider, "teleagent")
  assert.equal(plugin.auth.maxConcurrency, 3)
  assert.equal(plugin.auth.refreshLead, 24 * 3600_000)
  assert.equal(plugin.auth.methods.length, 2)
  assert.deepEqual(plugin.auth.methods.map((m) => m.label), ["浏览器登录（天翼账号）", "从本机 TeleAgent 客户端导入"])
  for (const hook of ["refresh", "loader", "usage"]) {
    assert.equal(typeof plugin.auth[hook], "function", hook)
  }
  assert.equal(plugin.provider.id, "teleagent")

  const models = await plugin.provider.models()
  assert.deepEqual(Object.keys(models).sort(), ["chat-flagship", "chat-flash", "chat-pro"])
})

test("JWT：tenant 前缀不剥，第三段就是签名密钥；exp 可解", () => {
  assert.equal(jwtParts(VECTOR.token).length, 3)
  assert.equal(jwtPayload(VECTOR.token).accountId, "acct-123")
  assert.equal(tokenExpiresAt(VECTOR.token), 1793800000 * 1000)
  assert.equal(accountKey(VECTOR.token), "acct-123")
})

test("identityOf：确定性、12 位 hex 设备号、UUID 形态安装号", () => {
  const a = deviceIdentity("acct-123")
  const b = deviceIdentity("acct-123")
  const c = deviceIdentity("acct-456")
  assert.deepEqual(a, b)
  assert.notDeepEqual(a, c)
  assert.match(a.deviceId, /^[0-9a-f]{12}$/u)
  assert.match(a.installId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
})

test("identityOfAuth：metadata 优先，缺失时按账号锚点重算", () => {
  assert.deepEqual(
    identityOfAuth({ metadata: { deviceId: "aaaaaaaaaaaa", installId: "x" } }),
    { deviceId: "aaaaaaaaaaaa", installId: "x" },
  )
  assert.deepEqual(
    identityOfAuth({ metadata: { accountId: "acct-123" } }),
    deviceIdentity("acct-123"),
  )
  assert.throws(() => identityOfAuth({}), /账号标识/u)
})

test("签名：canonical string / derived key / 最终签名与固定向量逐字节一致", () => {
  assert.equal(
    derivedKey({
      token: VECTOR.token,
      installId: VECTOR.installId,
      timestamp: VECTOR.timestamp,
      nonce: VECTOR.nonce,
    }),
    VECTOR.derivedKey,
  )
  assert.equal(
    canonicalRequest({
      method: "POST",
      pathWithQuery: VECTOR.path,
      body: VECTOR.body,
      timestamp: VECTOR.timestamp,
      nonce: VECTOR.nonce,
    }).split("\n")[6],
    "f21eb92dd00b4378926051b748d496835e91e06a89f99cf120f9ab9fb5fb7729",
  )

  const headers = signedHeaders({
    token: VECTOR.token,
    deviceId: VECTOR.deviceId,
    installId: VECTOR.installId,
    method: "POST",
    pathWithQuery: VECTOR.path,
    body: VECTOR.body,
    nowMs: VECTOR.nowMs,
    nonce: VECTOR.nonce,
  })
  assert.equal(headers["X-SuperAgent-Signature"], VECTOR.signature)
  assert.equal(headers["X-SuperAgent-Timestamp"], VECTOR.timestamp) // 秒，不是毫秒
  assert.equal(headers["X-SuperAgent-Sign-Version"], "v1")
  assert.equal(headers["X-Token"], VECTOR.token)
  assert.equal(headers.Authorization, undefined)
})

test("业务头不签名（业务端点实测不需要）", () => {
  const headers = businessHeaders({
    token: VECTOR.token,
    deviceId: VECTOR.deviceId,
    installId: VECTOR.installId,
    nowMs: VECTOR.nowMs,
    nonce: VECTOR.nonce,
  })
  assert.equal(headers["X-Token"], VECTOR.token)
  // 业务面两套头同时发：superagent 那套 + 渲染进程那套
  assert.equal(headers["X-SuperAgent-Timestamp"], VECTOR.timestamp)
  assert.equal(headers["X-Timestamp"], VECTOR.timestamp)
  assert.equal(headers["X-SuperAgent-Signature"], undefined)
})

test("浏览器发现：env 覆盖 / macOS 常见路径 / 找不到", () => {
  const override = findBrowser({
    env: { MAGPIE_TELEAGENT_BROWSER: "D:\\Chrome\\chrome.exe" },
    exists: (file) => file === "D:\\Chrome\\chrome.exe",
    whichFn: () => "",
  })
  assert.equal(override, "D:\\Chrome\\chrome.exe")

  const mac = findBrowser({
    platform: "darwin",
    env: {},
    exists: (file) => file === "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    whichFn: () => "",
  })
  assert.equal(mac, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")

  assert.equal(findBrowser({ platform: "win32", env: {}, exists: () => false, whichFn: () => "" }), "")
})

test("浏览器 token：operationToken 优先、解码 URL 编码、只认 teleai 域名", () => {
  assert.equal(decodeTokenValue("Em9xR4%3Aabc"), "Em9xR4:abc")
  assert.equal(tokenFromCookies([
    { name: "x-token", value: "wrong", domain: ".teleai.com.cn" },
    { name: "operationToken", value: "Em9xR4%3Aabc", domain: ".teleai.com.cn" },
  ]), "Em9xR4:abc")
  assert.equal(tokenFromCookies([
    { name: "operationToken", value: "abc", domain: ".evil.com" },
  ]), "")
  assert.equal(tokenFromCookies([]), "")
})

test("sanitizeChatBody：白名单、字段改名、max_tokens 封顶", () => {
  const body = sanitizeChatBody(JSON.stringify({
    model: "chat-flash",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
    metadata: { a: 1 },
    top_k: 5,
    thinking: { type: "enabled" },
    system: "x",
    reasoning_effort: "low",
    max_completion_tokens: 40_000,
  }))
  const parsed = JSON.parse(body)
  assert.equal(parsed.model, "chat-flash")
  assert.equal(parsed.max_tokens, 40_000) // 40k 未超过 65536，不截断
  assert.equal(parsed.stream, true)
  assert.equal(parsed.reasoning_effort, "low")

  const capped = JSON.parse(sanitizeChatBody(JSON.stringify({ model: "chat-pro", max_tokens: 999_999 })))
  assert.equal(capped.max_tokens, 65_536)

  const defaulted = JSON.parse(sanitizeChatBody(JSON.stringify({ model: "chat-flash" }), { reasoningEffort: "max" }))
  assert.equal(defaulted.reasoning_effort, "max")
  const explicit = JSON.parse(sanitizeChatBody(JSON.stringify({ model: "chat-flash", reasoning_effort: "low" }), { reasoningEffort: "max" }))
  assert.equal(explicit.reasoning_effort, "low")

  assert.throws(() => sanitizeChatBody("{not json"), (error) => error.status === 400)
})

test("空响应判定：tool_calls 不算空", () => {
  assert.equal(isEmptyCompletion(JSON.stringify({ choices: [] })), true)
  assert.equal(isEmptyCompletion(JSON.stringify({ choices: [{ message: { content: "" } }] })), true)
  assert.equal(isEmptyCompletion(JSON.stringify({ choices: [{ message: { content: "ok" } }] })), false)
  assert.equal(isEmptyCompletion(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: "t" }] } }] })), false)
  assert.equal(isEmptyCompletion("<html>"), false)
})

test("40301 / 40104 判成签名问题，不是账号过期", () => {
  assert.equal(isSigningError({ code: 40301 }), true)
  assert.equal(isSigningError({ code: "40104" }), true)
  assert.equal(isSigningError({ code: 40001 }), false)
})

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  })
}

test("completeLogin：user_info 回填账号名/uid/设备身份/exp，业务端点不签名", async () => {
  const fetchImpl = async (url, init) => {
    assert.match(String(url), /cowork\/user_info/u)
    const headers = new Headers(init.headers)
    assert.equal(headers.get("X-Token"), VECTOR.token)
    assert.equal(headers.get("X-SuperAgent-Signature"), null) // 业务端点不签名
    assert.equal(headers.get("User-Agent"), "opencode/1.2.27 ai-sdk/provider-utils/3.0.20 runtime/bun/1.3.10")
    return jsonResponse({
      code: 200,
      data: { accountId: "acct-123", accountName: "张三", phone: "13800001111" },
    })
  }

  const result = await _internal.completeLogin(VECTOR.token, fetchImpl)
  assert.equal(result.type, "success")
  assert.equal(result.access, VECTOR.token)
  assert.equal(result.accountId, "张三")
  assert.equal(result.uid, "acct-123")
  assert.equal(result.expires, 1793800000 * 1000)
  assert.equal(result.metadata.email, "张三")
  assert.deepEqual(
    { deviceId: result.metadata.deviceId, installId: result.metadata.installId },
    deviceIdentity("acct-123"),
  )
})

test("completeLogin：上游回登录页 HTML → 判成登录失效", async () => {
  const fetchImpl = async () => new Response("<html>login</html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  })
  await assert.rejects(
    () => _internal.completeLogin(VECTOR.token, fetchImpl),
    (error) => error.code === "session_expired",
  )
})

test("completeLogin：Web 的非三段 token 也能走 user_info 校验", async () => {
  const fetchImpl = async () => jsonResponse({
    code: 200,
    data: { accountId: "acct-web", accountName: "Web 用户" },
  })
  const result = await _internal.completeLogin("opaque-web-token", fetchImpl)
  assert.equal(result.type, "success")
  assert.equal(result.access, "opaque-web-token")
  assert.equal(result.uid, "acct-web")
})

test("额度解析：余额是字符串、套餐名透传", async () => {
  const identity = deviceIdentity("acct-123")
  const fetchImpl = async () => jsonResponse({
    code: 200,
    data: { current_points_balance: "6100.00", plan_display_name: "免费版", welfare_club_enabled: true, max_concurrent_tasks: 3 },
  })

  const balance = await fetchPoints({ token: VECTOR.token, identity, fetchImpl })
  assert.equal(balance.balance, 6100)
  assert.equal(balance.plan, "免费版")
  assert.equal(balance.welfareEnabled, true)
  assert.equal(balance.maxConcurrentTasks, 3)
})

test("usage：只返回一条积分窗口（已用/总量）", async () => {
  const fetchImpl = async (url) => {
    const target = String(url)
    if (target.includes("userCenter")) {
      return jsonResponse({
        code: 200,
        data: { current_points_balance: "3098.5", plan_display_name: "免费版", max_concurrent_tasks: 3 },
      })
    }
    if (target.includes("points/detail")) {
      return jsonResponse({
        code: 200,
        data: {
          pointsBalance: 3098.5,
          groups: [{ active: [{ subItems: [
            { name: "月度积分赠礼", totalQuota: 3000, usedQuota: 1.5, balance: 2998.5 },
            { name: "每日登录积分", totalQuota: 100, usedQuota: 0, balance: 100 },
          ] }] }],
        },
      })
    }
    throw new Error("unexpected request: " + target)
  }
  const plugin = await TeleAgentPlugin({}, { fetch: fetchImpl })
  const auth = {
    access: VECTOR.token,
    uid: "acct-usage",
    accountId: "测试账号",
    metadata: { ...deviceIdentity("acct-123"), accountId: "acct-123" },
  }
  const result = await plugin.auth.usage(async () => auth)
  assert.equal(result.windows.length, 1)
  assert.equal(result.windows[0].name, "积分")
  assert.equal(result.windows[0].limit, 3100)
  assert.equal(result.windows[0].amount, 1.5)
  assert.equal(result.windows[0].display, "3,098.5 / 3,100 积分")
  assert.equal(result.balance, undefined)
})

test("checkin：v3 活动未领 → GET jump_url → 重查 completed → claimed + credit", async () => {
  const calls = []
  let claimed = false
  const activity = () => ({
    visible: true,
    action_text: claimed ? "已领取" : "立即领取",
    action_status: claimed ? "completed" : "not_joined",
    activity_title: '每日可领<span style="color: #3C67FF">100</span>积分',
    action_type: "api",
    jump_url: "/superCowork/sapi/user/portal/companyStore/checkTask?type=daily_login",
    is_main_activity: false,
  })
  const fetchImpl = async (url) => {
    const target = String(url)
    calls.push(target)
    if (target.includes("checkTask?type=")) {
      claimed = true
      return jsonResponse({ code: 200, data: [] })
    }
    if (target.includes("/v3/checkDayTask")) {
      return jsonResponse({ code: 200, data: { brand_title: "积分福利社", activity_data: [activity()] } })
    }
    if (target.includes("/points/detail")) {
      return jsonResponse({ code: 200, data: { pointsBalance: claimed ? 3200 : 3100, groups: [] } })
    }
    return jsonResponse({ code: 200, data: {} })
  }
  const plugin = await TeleAgentPlugin({}, { fetch: fetchImpl })
  const auth = {
    access: VECTOR.token,
    accountId: "测试账号",
    metadata: { ...deviceIdentity("acct-123"), accountId: "acct-123" },
  }
  const result = await plugin.auth.checkin(async () => auth)
  assert.equal(result.outcome, "claimed")
  assert.equal(result.credit, 100)
  assert.equal(calls.filter((u) => u.includes("checkTask?type=daily_login")).length, 1)
  assert.equal(calls.filter((u) => u.includes("/v3/checkDayTask")).length, 2)
})

test("checkin：今天已 completed 也报 claimed", async () => {
  const fetchImpl = async () => jsonResponse({
    code: 200,
    data: {
      brand_title: "积分福利社",
      activity_data: [{ visible: true, action_status: "completed", action_type: "api", jump_url: "/x" }],
    },
  })
  const plugin = await TeleAgentPlugin({}, { fetch: fetchImpl })
  const auth = { access: VECTOR.token, metadata: { ...deviceIdentity("acct-123"), accountId: "acct-123" } }
  const result = await plugin.auth.checkin(async () => auth)
  assert.equal(result.outcome, "claimed")
  assert.match(result.message, /已签到/u)
})

test("积分明细：三个积分包（含新人礼）→ 真实百分比与到期时间", async () => {
  const identity = deviceIdentity("acct-123")
  const fetchImpl = async () => jsonResponse({
    code: 200,
    data: {
      pointsBalance: 9000,
      groups: [{
        type: "campaign",
        typeName: "积分福利社",
        active: [{
          name: "积分福利社", totalQuota: 9000, usedQuota: 0, balance: 9000,
          effectiveEnd: "2026-11-30 23:59:59", isAggregated: true,
          subItems: [
            { name: "月度积分赠礼", totalQuota: 3000, usedQuota: 500, balance: 2500, effectiveEnd: "2026-11-30 23:59:59", planCode: "bp_sys_monthly_basic" },
            { name: "首登即赠积分礼", totalQuota: 3000, usedQuota: 0, balance: 3000, effectiveEnd: "2027-02-11 20:12:59", planCode: "bp_act_newuser" },
          ],
        }],
        invalid: [],
      }],
    },
  })

  const detail = await fetchPackages({ token: VECTOR.token, identity, fetchImpl })
  assert.equal(detail.balance, 9000)
  assert.equal(detail.packages.length, 2)
  assert.equal(detail.packages[0].name, "月度积分赠礼")
  assert.equal(detail.packages[0].usedQuota, 500)
  assert.equal(beijingIso(detail.packages[0].effectiveEnd), "2026-11-30T15:59:59.000Z")
})

test("模型目录：model-options 归一（倍率/默认档/预置窗口）", async () => {
  const identity = deviceIdentity("acct-123")
  const fetchImpl = async () => jsonResponse({
    code: 0,
    data: {
      language: "zh-CN",
      version: "v-hash",
      models: [
        { model: "chat-pro", display_name: "智能", is_default: true, points_multiplier: "0.6", context_limit: null },
        { model: "chat-flagship", display_name: "旗舰", points_multiplier: "1.0" },
        { model: "chat-flash", display_name: "极速", points_multiplier: "0.2" },
      ],
    },
  })
  const { models, version } = await fetchCatalog({ token: VECTOR.token, identity, fetchImpl, contextLength: 600_000 })
  assert.equal(version, "v-hash")
  assert.deepEqual(Object.keys(models).sort(), ["chat-flagship", "chat-flash", "chat-pro"])
  assert.equal(models["chat-pro"].limit.context, 600_000)
  assert.equal(models["chat-pro"].rate, "x0.6")
  assert.equal(models["chat-flagship"].rate, "x1.0")
  assert.equal(models["chat-pro"].capabilities.input.image, true)
  assert.equal(models["chat-flagship"].capabilities.input.image, false)
})

test("签到文案：「每日可领 N 积分」能读出来，读不到不编", () => {
  assert.equal(dailyPoints({
    activity_title: '每日可领<span style="color: #3C67FF">100</span>积分',
  }), 100)
  assert.equal(dailyPoints({ activity_title: "每日可领 50 积分" }), 50)
  assert.equal(dailyPoints({}), undefined)
})



test("上下文长度：读桌面端 preset-context.json，非法值回退 400K", () => {
  const root = mkdtempSync(join(tmpdir(), "teleagent-ctx-"))
  try {
    mkdirSync(join(root, "users", "owner-1"), { recursive: true })
    writeFileSync(join(root, "current-owner.json"), JSON.stringify({ ownerDir: "owner-1" }))
    const file = join(root, "users", "owner-1", "preset-context.json")
    writeFileSync(file, JSON.stringify({ state: { contextLength: 1_000_000 }, version: 1 }))
    assert.equal(readDesktopContextLength({ root }), 1_000_000)

    writeFileSync(file, JSON.stringify({ state: { contextLength: 12345 }, version: 1 }))
    assert.equal(readDesktopContextLength({ root }), DEFAULT_CONTEXT_LENGTH)

    // 当前账号没有设置时，不能拿别的账号的值
    mkdirSync(join(root, "users", "owner-2"), { recursive: true })
    writeFileSync(
      join(root, "users", "owner-2", "preset-context.json"),
      JSON.stringify({ state: { contextLength: 1_000_000 }, version: 1 }),
    )
    rmSync(file, { force: true })
    assert.equal(readDesktopContextLength({ root }), DEFAULT_CONTEXT_LENGTH)
    assert.equal(readDesktopContextLength({ root: join(root, "missing") }), DEFAULT_CONTEXT_LENGTH)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("本机导入：旧客户端明文 token 不依赖 Local State", () => {
  const root = mkdtempSync(join(tmpdir(), "teleagent-plain-"))
  try {
    mkdirSync(join(root, "users", "owner-1", "app-auth"), { recursive: true })
    writeFileSync(join(root, "current-owner.json"), JSON.stringify({ ownerDir: "owner-1" }))
    writeFileSync(
      join(root, "users", "owner-1", "app-auth", "token.json"),
      JSON.stringify({ token: VECTOR.token }),
    )
    assert.equal(importLocalToken({ root }), VECTOR.token)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("本机导入：safeStorage v10 信封可解出 token", () => {
  const key = Buffer.alloc(32, 7)
  const nonce = Buffer.alloc(12, 1)
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ token: VECTOR.token })),
    cipher.final(),
  ])
  const blob = Buffer.concat([Buffer.from("v10"), nonce, ciphertext, cipher.getAuthTag()])

  assert.equal(decryptSafeStorage(blob, key), JSON.stringify({ token: VECTOR.token }))
  assert.equal(
    tokenFromRecord({ encrypted: true, encryptedToken: blob.toString("base64") }, key),
    VECTOR.token,
  )
  assert.equal(tokenFromRecord({ token: VECTOR.token }, key), VECTOR.token)
  assert.throws(() => decryptSafeStorage(Buffer.from("v11x"), key))
  assert.throws(() => tokenFromRecord({}, key))
})

test("本机导入：macOS/Linux safeStorage v10/v11（AES-128-CBC）", () => {
  const password = "test-password"
  for (const [prefix, rounds] of [["v10", 1003], ["v11", 1]]) {
    const key = pbkdf2Sync(password, "saltysalt", rounds, 16, "sha1")
    const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20))
    const blob = Buffer.concat([Buffer.from(prefix), cipher.update(VECTOR.token), cipher.final()])
    assert.equal(decryptSafeStorageCbc(blob, password), VECTOR.token)
  }
  assert.throws(() => decryptSafeStorageCbc(Buffer.from("v10x"), ""))
})

test("本机导入：Linux local-key（AES-256-GCM）", () => {
  const key = Buffer.alloc(32, 5)
  const iv = Buffer.alloc(12, 6)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const ciphertext = Buffer.concat([cipher.update(VECTOR.token), cipher.final()])
  const blob = Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
  assert.equal(decryptLocalValue(blob, key), VECTOR.token)
})

test("本机导入：macOS safeStorage 记录（platform/password 注入）", () => {
  const root = mkdtempSync(join(tmpdir(), "teleagent-mac-"))
  try {
    const password = "mac-password"
    const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1")
    const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20))
    const blob = Buffer.concat([Buffer.from("v10"), cipher.update(VECTOR.token), cipher.final()])

    mkdirSync(join(root, "users", "owner-1", "app-auth"), { recursive: true })
    writeFileSync(join(root, "current-owner.json"), JSON.stringify({ ownerDir: "owner-1" }))
    writeFileSync(
      join(root, "users", "owner-1", "app-auth", "token.json"),
      JSON.stringify({ version: 1, scheme: "safe_storage", encrypted: true, encryptedToken: blob.toString("base64") }),
    )

    assert.equal(importLocalToken({ root, platform: "darwin", password }), VECTOR.token)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("本机导入：Linux local scheme 记录 + local-key", () => {
  const root = mkdtempSync(join(tmpdir(), "teleagent-local-"))
  try {
    const key = Buffer.alloc(32, 8)
    const iv = Buffer.alloc(12, 9)
    const cipher = createCipheriv("aes-256-gcm", key, iv)
    const ciphertext = Buffer.concat([cipher.update(VECTOR.token), cipher.final()])
    const blob = Buffer.concat([iv, cipher.getAuthTag(), ciphertext])

    mkdirSync(join(root, "users", "owner-1", "app-auth"), { recursive: true })
    writeFileSync(join(root, "current-owner.json"), JSON.stringify({ ownerDir: "owner-1" }))
    writeFileSync(
      join(root, "users", "owner-1", "app-auth", "token.json"),
      JSON.stringify({ version: 1, scheme: "local", encrypted: false, encryptedToken: blob.toString("base64") }),
    )
    writeFileSync(join(root, "users", "owner-1", "app-auth", "local-key"), key)

    assert.equal(importLocalToken({ root, platform: "linux" }), VECTOR.token)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("本机导入：Local State 主密钥 + token.json（临时目录，DPAPI 注入）", () => {
  const root = mkdtempSync(join(tmpdir(), "teleagent-import-"))
  try {
    const key = Buffer.alloc(32, 9)
    const wrapped = Buffer.concat([Buffer.from("DPAPI"), key])
    mkdirSync(join(root, "users", "owner-1", "app-auth"), { recursive: true })
    writeFileSync(
      join(root, "Local State"),
      JSON.stringify({ os_crypt: { encrypted_key: wrapped.toString("base64") } }),
    )
    writeFileSync(join(root, "current-owner.json"), JSON.stringify({ ownerDir: "owner-1" }))

    const nonce = Buffer.alloc(12, 2)
    const cipher = createCipheriv("aes-256-gcm", key, nonce)
    const ciphertext = Buffer.concat([cipher.update(VECTOR.token), cipher.final()])
    const blob = Buffer.concat([Buffer.from("v10"), nonce, ciphertext, cipher.getAuthTag()])
    writeFileSync(
      join(root, "users", "owner-1", "app-auth", "token.json"),
      JSON.stringify({ encrypted: true, encryptedToken: blob.toString("base64") }),
    )

    const fakeDpapi = (input) => {
      assert.deepEqual(input, key) // 已经剥掉 "DPAPI" 前缀
      return key
    }

    assert.deepEqual(readMasterKey(root, { dpapi: fakeDpapi }), key)
    assert.equal(importLocalToken({ root, dpapi: fakeDpapi }), VECTOR.token)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("续期端点：token-refresh 解析 accessToken/expiresIn", async () => {
  const fetchImpl = async () => jsonResponse({
    code: 0,
    data: { accessToken: "new-token", expiresIn: 3600, absoluteExpiresAt: 1_800_000_000 },
  })
  const result = await refreshAccessToken(VECTOR.token, deviceIdentity("acct-123"), { fetchImpl })
  assert.equal(result.access, "new-token")
  assert.ok(result.expires > Date.now())
})

test("续期端点：40114/401 判成登录失效，404 判成旧服务端", async () => {
  const expired = async () => new Response(JSON.stringify({ code: 40114, message: "expired" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  })
  await assert.rejects(
    () => refreshAccessToken(VECTOR.token, deviceIdentity("acct-123"), { fetchImpl: expired }),
    (error) => error.status === 401 && error.code === "session_expired",
  )

  const missing = async () => new Response("Not Found", { status: 404 })
  await assert.rejects(
    () => refreshAccessToken(VECTOR.token, deviceIdentity("acct-123"), { fetchImpl: missing }),
    (error) => error.status === 404,
  )
})

test("refresh：到期前调用 token-refresh 并返回新 access/expires", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("token-refresh")) {
      return jsonResponse({ code: 0, data: { accessToken: "new-token", expiresIn: 3600 } })
    }
    throw new Error("unexpected request: " + url)
  }
  const plugin = await TeleAgentPlugin({}, { fetch: fetchImpl })
  const auth = {
    access: VECTOR.token,
    metadata: { ...deviceIdentity("acct-123"), accountId: "acct-123" },
  }
  const result = await plugin.auth.refresh(auth)
  assert.equal(result.access, "new-token")
  assert.ok(result.expires > Date.now())
  assert.equal(plugin.auth.refreshLead, 1_800_000) // 1h TTL 的一半
})

test("refresh：旧服务端 404 时退回 user_info 探测，不报错", async () => {
  const fetchImpl = async (url) => {
    const target = String(url)
    if (target.includes("token-refresh")) return new Response("Not Found", { status: 404 })
    if (target.includes("user_info")) {
      return jsonResponse({ code: 200, data: { accountId: "acct-123", accountName: "张三" } })
    }
    throw new Error("unexpected request: " + target)
  }
  const plugin = await TeleAgentPlugin({}, { fetch: fetchImpl })
  const auth = {
    access: VECTOR.token,
    metadata: { ...deviceIdentity("acct-123"), accountId: "acct-123" },
  }
  assert.equal(await plugin.auth.refresh(auth), undefined)
})

test("并发上限：账号 metadata 里的 maxConcurrentTasks 更新 auth.maxConcurrency", async () => {
  const plugin = await TeleAgentPlugin({}, {})
  assert.equal(plugin.auth.maxConcurrency, 3)
  await plugin.auth.loader(async () => ({
    access: VECTOR.token,
    metadata: { deviceId: "aaaaaaaaaaaa", installId: "x", maxConcurrentTasks: 8, ttlMs: 3_600_000 },
  }))
  assert.equal(plugin.auth.maxConcurrency, 8)
  assert.equal(plugin.auth.refreshLead, 1_800_000)
})

test("loader.fetch：清洗 + 签名 + X-Token，不带 Authorization", async () => {
  let captured
  const fetchImpl = async (url, init) => {
    captured = { url: String(url), init }
    return new Response(JSON.stringify({
      id: "chatcmpl-1",
      choices: [{ message: { role: "assistant", content: "你好" } }],
    }), { status: 200, headers: { "content-type": "application/json" } })
  }

  const plugin = await TeleAgentPlugin({}, { fetch: fetchImpl })
  const auth = { access: VECTOR.token, metadata: { ...deviceIdentity("acct-123"), accountId: "acct-123" } }
  const loaded = await plugin.auth.loader(async () => auth)

  const response = await loaded.fetch(
    "https://agent.teleai.com.cn/superCowork/sapi/api/v1/chat/completions",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chat-flash",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
        metadata: { dropped: true },
      }),
    },
  )

  const headers = new Headers(captured.init.headers)
  assert.equal(response.status, 200)
  assert.equal(captured.url, "https://agent.teleai.com.cn/superCowork/sapi/api/v1/chat/completions")
  assert.equal(JSON.parse(captured.init.body).metadata, undefined)
  assert.equal(headers.get("X-Token"), VECTOR.token)
  assert.equal(headers.get("Authorization"), null)
  assert.equal(headers.get("X-Route-Target"), "ops-gateway")
  assert.match(headers.get("X-SuperAgent-Signature"), /^[0-9a-f]{64}$/u)
  assert.match(headers.get("X-SuperAgent-Timestamp"), /^\d{10}$/u) // 秒级
})

test("非流式空响应：重试一次；两次都空报 503", async () => {
  const auth = { access: VECTOR.token, metadata: { ...deviceIdentity("acct-123"), accountId: "acct-123" } }
  const url = "https://agent.teleai.com.cn/superCowork/sapi/api/v1/chat/completions"
  const requestBody = JSON.stringify({ model: "chat-flash", messages: [], stream: false })

  let calls = 0
  const flaky = async () => {
    calls += 1
    const payload = calls === 1
      ? { choices: [] }
      : { choices: [{ message: { role: "assistant", content: "ok" } }] }
    return jsonResponse(payload)
  }
  const plugin = await TeleAgentPlugin({}, { fetch: flaky })
  const loaded = await plugin.auth.loader(async () => auth)
  const response = await loaded.fetch(url, { method: "POST", body: requestBody })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).choices[0].message.content, "ok")
  assert.equal(calls, 2)

  const empty = async () => jsonResponse({ choices: [] })
  const plugin2 = await TeleAgentPlugin({}, { fetch: empty })
  const loaded2 = await plugin2.auth.loader(async () => auth)
  const response2 = await loaded2.fetch(url, { method: "POST", body: requestBody })
  assert.equal(response2.status, 503)
  assert.equal((await response2.json()).error.code, "upstream_unavailable")
})

test("loader.fetch：上游 40301 → 401 + signing_error + kept", async () => {
  const fetchImpl = async () => new Response(
    JSON.stringify({ code: 40301, message: "检测到客户端版本过低，请检查新版本并升级以继续使用" }),
    { status: 403, headers: { "content-type": "application/json" } },
  )
  const plugin = await TeleAgentPlugin({}, { fetch: fetchImpl })
  const auth = { access: VECTOR.token, metadata: { ...deviceIdentity("acct-123"), accountId: "acct-123" } }
  const loaded = await plugin.auth.loader(async () => auth)

  const response = await loaded.fetch(
    "https://agent.teleai.com.cn/superCowork/sapi/api/v1/chat/completions",
    { method: "POST", body: JSON.stringify({ model: "chat-flash", messages: [], stream: false }) },
  )
  const payload = await response.json()

  assert.equal(response.status, 401)
  assert.equal(response.headers.get("X-Magpie-Sign-In"), "kept")
  assert.equal(payload.error.code, "signing_error")
})
