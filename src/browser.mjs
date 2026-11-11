// 浏览器登录：开一个临时 Chromium（Chrome/Edge/Brave）窗口，用户在窗口里登录，
// 插件通过 CDP 读 operationToken。参考 Magpie 里 WPS Lingxi 插件的同一套路：
// 不依赖厂商回调地址，也不需要用户复制任何东西。

import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const COOKIE_NAMES = ["operationToken", "operToken", "accessToken", "x-token"]
const POLL_MS = 1000
const START_MS = 15_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function which(name, platform = process.platform) {
  try {
    const out = execFileSync(platform === "win32" ? "where" : "which", [name], {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    })
    return out.split(/\r?\n/u).map((line) => line.trim()).find((line) => line && existsSync(line)) || ""
  } catch {
    return ""
  }
}

/** 找 Chromium 内核浏览器；MAGPIE_TELEAGENT_BROWSER 可显式指定 exe */
export function findBrowser({
  env = process.env,
  platform = process.platform,
  exists = existsSync,
  whichFn = which,
} = {}) {
  const override = String(env.MAGPIE_TELEAGENT_BROWSER ?? "").trim()
  if (override && exists(override)) return override

  const candidates = []
  if (platform === "win32") {
    const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter(Boolean)
    for (const root of roots) {
      candidates.push(
        join(root, "Google", "Chrome", "Application", "chrome.exe"),
        join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
        join(root, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
        join(root, "Chromium", "Application", "chrome.exe"),
      )
    }
    for (const name of ["chrome", "msedge", "brave"]) candidates.push(whichFn(name, platform))
  } else if (platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    )
  } else {
    for (const name of ["google-chrome", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"]) {
      candidates.push(whichFn(name, platform))
    }
  }
  return candidates.find((file) => file && exists(file)) || ""
}

/** cookie 值可能是 URL 编码的；JWT 里没有 %，最多解 3 层 */
export function decodeTokenValue(value) {
  let text = String(value ?? "").trim()
  for (let i = 0; i < 3 && text.includes("%"); i += 1) {
    try {
      text = decodeURIComponent(text)
    } catch {
      break
    }
  }
  return text
}

/** 从 CDP 的 cookie 列表里取 TeleAgent 的 Web token（operationToken 优先） */
export function tokenFromCookies(cookies = []) {
  for (const name of COOKIE_NAMES) {
    const hit = cookies.find((cookie) => {
      if (cookie?.name !== name) return false
      if (!String(cookie.value ?? "").trim()) return false
      const domain = String(cookie.domain ?? "").replace(/\.$/u, "")
      return /(^|\.)teleai\.com\.cn$/iu.test(domain)
    })
    if (hit) return decodeTokenValue(hit.value)
  }
  return ""
}

function cdpConnect(url) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket !== "function") {
      reject(new Error("当前运行时不支持浏览器自动登录（没有 WebSocket）"))
      return
    }
    const socket = new WebSocket(url)
    const pending = new Map()
    let next = 1
    const timer = setTimeout(() => {
      try { socket.close() } catch {}
      reject(new Error("连接浏览器调试端口超时"))
    }, 5000)

    socket.onopen = () => {
      clearTimeout(timer)
      resolve({
        send(method, params) {
          const id = next++
          return new Promise((res, rej) => {
            pending.set(id, { res, rej })
            socket.send(JSON.stringify({ id, method, params: params ?? {} }))
          })
        },
        close() {
          try { socket.close() } catch {}
        },
      })
    }
    socket.onmessage = (event) => {
      let message
      try {
        message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data))
      } catch {
        return
      }
      const waiter = message?.id ? pending.get(message.id) : null
      if (!waiter) return
      pending.delete(message.id)
      if (message.error) waiter.rej(new Error(message.error.message || "CDP 错误"))
      else waiter.res(message.result)
    }
    socket.onerror = () => {
      clearTimeout(timer)
      reject(new Error("连不上浏览器调试端口"))
    }
    socket.onclose = () => {
      clearTimeout(timer)
      for (const waiter of pending.values()) waiter.rej(new Error("浏览器调试连接已断开"))
      pending.clear()
    }
  })
}

async function pageTarget(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(3000),
  })
  if (!response.ok) return null
  const targets = await response.json()
  if (!Array.isArray(targets)) return null
  return targets.find((target) => target?.type === "page" && target.webSocketDebuggerUrl && String(target.url).includes("teleai.com.cn"))
    ?? targets.find((target) => target?.type === "page" && target.webSocketDebuggerUrl)
    ?? null
}

async function readToken(port) {
  const target = await pageTarget(port)
  if (!target) return ""
  const client = await cdpConnect(target.webSocketDebuggerUrl)
  try {
    await client.send("Network.enable")
    const { cookies } = await client.send("Network.getAllCookies")
    const fromCookie = tokenFromCookies(cookies)
    if (fromCookie) return fromCookie

    const { result } = await client.send("Runtime.evaluate", {
      expression:
        "JSON.stringify({cookie:document.cookie,"
        + "sso:localStorage.getItem('sso_token'),"
        + "console:localStorage.getItem('console_token')})",
      returnByValue: true,
    })
    let data = {}
    try {
      data = JSON.parse(result?.value ?? "{}")
    } catch {}
    const fromDocument = /(?:^|; )operationToken=([^;]+)/u.exec(String(data.cookie ?? ""))?.[1]
    return decodeTokenValue(data.sso || data.console || fromDocument || "")
  } finally {
    client.close()
  }
}

async function waitForFile(file, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    if (existsSync(file)) return true
    await sleep(200)
  }
  return false
}

/**
 * 打开临时浏览器登录，返回 operationToken。
 * 浏览器登录成功后由插件关闭；临时 profile 随后删除。
 */
export async function chromiumLogin({ browser = findBrowser(), url, timeoutMs = 5 * 60_000, signal } = {}) {
  if (!browser) {
    throw new Error(
      "没有找到 Chromium 内核浏览器（Chrome / Edge / Brave）。装一个，"
      + "或用 MAGPIE_TELEAGENT_BROWSER 指向它的 exe；也可以改用「从本机 TeleAgent 客户端导入」。",
    )
  }
  if (!url) throw new TypeError("chromiumLogin: url 不能为空")

  const profile = mkdtempSync(join(tmpdir(), "magpie-teleagent-"))
  const child = spawn(browser, [
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
    "--disable-popup-blocking",
    url,
  ], { stdio: "ignore", windowsHide: false })

  let exited = false
  let spawnError
  child.once("error", (error) => {
    spawnError = error
    exited = true
  })
  child.once("exit", () => { exited = true })

  const onAbort = () => {
    try { child.kill("SIGTERM") } catch {}
  }
  signal?.addEventListener("abort", onAbort, { once: true })

  try {
    const portFile = join(profile, "DevToolsActivePort")
    if (!(await waitForFile(portFile, START_MS, signal))) {
      throw new Error(
        spawnError ? `浏览器启动失败：${spawnError.message}` : "浏览器没有打开调试端口（可能被安全软件拦截）",
      )
    }
    const port = Number(readFileSync(portFile, "utf8").split(/\r?\n/u)[0])
    if (!Number.isFinite(port) || port <= 0) throw new Error("浏览器调试端口无效")

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      signal?.throwIfAborted()
      if (exited) throw new Error("浏览器窗口已关闭")
      try {
        const token = await readToken(port)
        if (token) return token
      } catch {}
      await sleep(POLL_MS)
    }
    throw new Error("等待浏览器登录超时（5 分钟）")
  } finally {
    signal?.removeEventListener("abort", onAbort)
    try { child.kill("SIGTERM") } catch {}
    // 临时 profile 常被浏览器占用，重试几次再放弃
    const cleanup = (attempt = 0) => {
      try {
        rmSync(profile, { recursive: true, force: true })
      } catch (error) {
        if (attempt < 2) {
          setTimeout(() => cleanup(attempt + 1), 800).unref?.()
        } else {
          console.warn(`[magpie-TeleAgent] 临时浏览器 profile 清理失败：${error.message}`)
        }
      }
    }
    setTimeout(() => cleanup(), 1200).unref?.()
  }
}
