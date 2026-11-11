// 凭据：解 JWT、派生设备身份、从本机桌面端导入。

import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto"
import { execFileSync } from "node:child_process"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { ApiError, CODES } from "./errors.mjs"

/** 三段式：`<tenant>:<header>.<payload>.<signature>`，冒号只在第一段里 */
export function jwtParts(token) {
  return String(token ?? "").trim().split(".")
}

export function jwtPayload(token) {
  const parts = jwtParts(token)
  if (parts.length !== 3 || !parts[1]) return undefined
  try {
    const value = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
    return value && typeof value === "object" ? value : undefined
  } catch {
    return undefined
  }
}

export function tokenExpiresAt(token) {
  const exp = jwtPayload(token)?.exp
  if (typeof exp !== "number" || !Number.isFinite(exp)) return undefined
  const ms = exp * 1000
  return Number.isFinite(ms) ? ms : undefined
}

/** 账号锚点：JWT 里的 accountId 最稳；拿不到才退回 token 指纹 */
export function accountKey(token) {
  const payload = jwtPayload(token)
  const id = payload?.accountId ?? payload?.accountName ?? payload?.sub
  const text = typeof id === "string" || typeof id === "number" ? String(id).trim() : ""
  return text || createHash("sha256").update(String(token)).digest("hex").slice(0, 16)
}

/* ────────────────────────────── 设备身份 ────────────────────────────── */

/**
 * 由账号锚点确定性派生：deviceId 12 位 hex，installId UUID 形态。
 * 同一账号每次登录得到同一组值，不需要额外持久化。
 */
export function deviceIdentity(seed) {
  const key = String(seed ?? "").trim()
  if (!key) throw new ApiError("缺少账号标识，请重新登录", { status: 401, code: CODES.signInRequired })

  const deviceId = createHash("sha256").update(`teleagent-device:${key}`).digest("hex").slice(0, 12)

  const bytes = Buffer.from(
    createHash("sha256").update(`teleagent-install:${key}`).digest().subarray(0, 16),
  )
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const h = bytes.toString("hex")
  return {
    deviceId,
    installId: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`,
  }
}

/** magpie auth 记录 → 设备头 */
export function identityOfAuth(auth) {
  const meta = auth?.metadata ?? {}
  const deviceId = String(meta.deviceId ?? "").trim()
  const installId = String(meta.installId ?? "").trim()
  if (deviceId && installId) return { deviceId, installId }

  const seed = String(meta.accountId ?? auth?.uid ?? auth?.accountId ?? "").trim()
  if (seed) return deviceIdentity(seed)
  if (auth?.access) return deviceIdentity(accountKey(auth.access))
  throw new ApiError("凭据缺少账号标识，请重新登录", { status: 401, code: CODES.signInRequired })
}

/* ────────────────────────────── 本机导入 ────────────────────────────── */

export function teleagentDataRoot(env = process.env) {
  // 桌面端把 Electron 的 userData 指到 TELEAI_DATA_ROOT；引擎侧叫 TELEAGENT_DATA_DIR。
  // 两者都没有时，3.0.1 在所有平台都用 ~/.local/share/TeleAgent。
  return (
    String(env.TELEAI_DATA_ROOT ?? "").trim()
    || String(env.TELEAGENT_DATA_DIR ?? "").trim()
    || join(homedir(), ".local", "share", "TeleAgent")
  )
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

function mtime(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/** DPAPI 只保护 safeStorage 主密钥；token 本身是 AES-256-GCM */
export function dpapiUnprotect(blob) {
  if (process.platform !== "win32") {
    throw new Error("DPAPI 只在 Windows 上可用")
  }
  const script = [
    "Add-Type -AssemblyName System.Security | Out-Null;",
    "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());",
    "$u=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');",
    "[Convert]::ToBase64String($u)",
  ].join(" ")
  const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input: blob.toString("base64"),
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  })
  return Buffer.from(out.trim(), "base64")
}

/** `v10` + 12B nonce + 密文 + 16B tag */
export function decryptSafeStorage(blob, key) {
  const prefix = blob.subarray(0, 3).toString("latin1")
  if (prefix !== "v10" && prefix !== "v11") {
    throw new Error(`未知的 safeStorage 前缀：${JSON.stringify(prefix)}`)
  }
  if (key.length !== 32) throw new Error(`safeStorage 主密钥长度应为 32，实际 ${key.length}`)
  if (blob.length <= 3 + 12 + 16) throw new Error("safeStorage 密文过短")

  const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(3, 15))
  decipher.setAuthTag(blob.subarray(blob.length - 16))
  return Buffer.concat([decipher.update(blob.subarray(15, blob.length - 16)), decipher.final()]).toString("utf8")
}

/** macOS：Electron safeStorage 的钥匙串项（service/account 都试一遍，兼容改名） */
export function macSafeStoragePassword() {
  const fromEnv = String(process.env.TELEAGENT_SAFE_STORAGE_PASSWORD ?? "").trim()
  if (fromEnv) return fromEnv

  const names = ["TeleAgent", "super-agent", "superagent", "Electron", "Chromium"]
  for (const name of names) {
    for (const service of [`${name} Safe Storage`, name]) {
      for (const args of [
        ["find-generic-password", "-s", service, "-a", name, "-w"],
        ["find-generic-password", "-s", service, "-w"],
      ]) {
        const password = runQuiet("security", args)
        if (password) return password
      }
    }
  }
  throw new Error(
    "读取 macOS 钥匙串失败：请在系统弹窗里允许访问「TeleAgent Safe Storage」，"
    + "或先在桌面端重新登录一次再导入",
  )
}

/** Linux：libsecret 里的 safeStorage 密码；没有 keyring 时 Electron 用 basic_text 的 "peanuts" */
export function linuxSafeStoragePassword() {
  const fromEnv = String(process.env.TELEAGENT_SAFE_STORAGE_PASSWORD ?? "").trim()
  if (fromEnv) return fromEnv

  for (const app of ["TeleAgent", "teleagent", "super-agent", "superagent", "chromium", "chrome", "electron"]) {
    const password = runQuiet("secret-tool", ["lookup", "application", app])
    if (password) return password
  }
  return "peanuts"
}

function runQuiet(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).replace(/\r?\n$/u, "").trim()
  } catch {
    return ""
  }
}

/** macOS / Linux：`v10`/`v11` + AES-128-CBC（PBKDF2-SHA1("saltysalt")，IV 16 个空格） */
export function decryptSafeStorageCbc(blob, password, { iterations } = {}) {
  const prefix = blob.subarray(0, 3).toString("latin1")
  if (prefix !== "v10" && prefix !== "v11") {
    throw new Error(`未知的 safeStorage 前缀：${JSON.stringify(prefix)}`)
  }
  if (typeof password !== "string" || !password) throw new Error("safeStorage 密码为空")
  if (blob.length <= 3 + 16) throw new Error("safeStorage 密文过短")

  // Linux 的 v11 只迭代 1 次（basic_text），v10 迭代 1003 次；macOS 固定 1003。
  const rounds = Number.isInteger(iterations) && iterations > 0 ? iterations : prefix === "v11" ? 1 : 1003
  const key = pbkdf2Sync(password, "saltysalt", rounds, 16, "sha1")
  const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20))
  return Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()]).toString("utf8")
}

/** Linux 无 keyring 时的 local-secret-codec：AES-256-GCM，密钥在 app-auth/local-key */
export function decryptLocalValue(blob, key) {
  if (key.length !== 32) throw new Error(`local-key 长度应为 32，实际 ${key.length}`)
  if (blob.length <= 12 + 16) throw new Error("local-key 密文过短")
  const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12))
  decipher.setAuthTag(blob.subarray(12, 28))
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString("utf8")
}

/** token.json → token（新格式加密 / 旧格式明文都认） */
export function tokenFromRecord(record, key, { decrypt } = {}) {
  const plain = typeof record?.token === "string" ? record.token.trim() : ""
  if (plain && record?.encrypted !== true) return plain

  const encoded = String(record?.encryptedToken ?? record?.token ?? "").trim()
  if (!encoded) throw new Error("token.json 里没有 encryptedToken")

  const read = decrypt ?? ((blob) => decryptSafeStorage(blob, key))
  const text = read(Buffer.from(encoded, "base64")).trim()
  if (!text) throw new Error("safeStorage 解密结果为空")
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text)
      if (typeof parsed?.token === "string" && parsed.token.trim()) return parsed.token.trim()
    } catch {}
  }
  return text
}

/** `Local State` → 32 字节主密钥（DPAPI 可注入，测试用） */
export function readMasterKey(root, { dpapi = dpapiUnprotect } = {}) {
  const state = readJson(join(root, "Local State"))
  const encoded = String(state?.os_crypt?.encrypted_key ?? "").trim()
  if (!encoded) throw new Error("Local State 里没有 os_crypt.encrypted_key")

  const wrapped = Buffer.from(encoded, "base64")
  if (wrapped.length <= 5 || wrapped.subarray(0, 5).toString("latin1") !== "DPAPI") {
    throw new Error("os_crypt.encrypted_key 不是 DPAPI 保护的主密钥")
  }
  const key = dpapi(wrapped.subarray(5))
  if (key.length !== 32) throw new Error(`DPAPI 解出的主密钥长度应为 32，实际 ${key.length}`)
  return key
}

/** 账号目录：current-owner 优先，其余按 token.json 修改时间倒序 */
export function ownerDirs(root) {
  const dirs = []
  const owner = readJson(join(root, "current-owner.json"))?.ownerDir
  if (owner) dirs.push(join(root, "users", String(owner)))

  try {
    const rest = readdirSync(join(root, "users"))
      .map((name) => join(root, "users", name))
      .sort((a, b) => mtime(join(b, "app-auth", "token.json")) - mtime(join(a, "app-auth", "token.json")))
    for (const dir of rest) if (!dirs.includes(dir)) dirs.push(dir)
  } catch {}
  return dirs
}

/** 桌面端「上下文长度」可选值（设置 → 预置模型） */
export const CONTEXT_CHOICES = Object.freeze([200_000, 400_000, 600_000, 800_000, 1_000_000])
export const DEFAULT_CONTEXT_LENGTH = 400_000

/**
 * 读桌面端当前选的上下文长度（账号级 preset-context.json）。
 * 读不到 / 值不在白名单 → 回退 400K，不猜。
 */
export function readDesktopContextLength({ root = teleagentDataRoot() } = {}) {
  // 只认 current-owner 指到的账号；没有 current-owner 时才退回扫描
  const owner = readJson(join(root, "current-owner.json"))?.ownerDir
  const dirs = owner ? [join(root, "users", String(owner))] : ownerDirs(root)
  for (const dir of dirs) {
    const value = readJson(join(dir, "preset-context.json"))?.state?.contextLength
    if (CONTEXT_CHOICES.includes(value)) return value
  }
  return DEFAULT_CONTEXT_LENGTH
}

/** 桌面端的设备身份（app-auth/device-meta.json；deviceId 12 hex、installId UUID） */
export function readDesktopDeviceMeta({ root = teleagentDataRoot() } = {}) {
  const meta = readJson(join(root, "app-auth", "device-meta.json"))
  const deviceId = String(meta?.deviceId ?? "").trim()
  const installId = String(meta?.installId ?? "").trim()
  return deviceId && installId ? { deviceId, installId } : undefined
}

export function importLocalToken({
  root = teleagentDataRoot(),
  dpapi,
  platform = process.platform,
  password,
} = {}) {
  // 有 current-owner 时只认当前账号；没写时才扫描其余账号
  const owner = readJson(join(root, "current-owner.json"))?.ownerDir
  const dirs = owner ? [join(root, "users", String(owner))] : ownerDirs(root)

  // 旧客户端是明文 token：先认它，连密钥都不用
  for (const dir of dirs) {
    const record = readJson(join(dir, "app-auth", "token.json"))
    if (record && record.encrypted !== true && typeof record.token === "string" && record.token.trim()) {
      return record.token.trim()
    }
  }

  const errors = []
  let safeStorageDecrypt
  for (const dir of dirs) {
    const record = readJson(join(dir, "app-auth", "token.json"))
    if (!record) continue
    try {
      // Linux 无 keyring 时桌面端不用 safeStorage，改用自己的 local-key（AES-256-GCM）
      if (record.scheme === "local") {
        const localKey = readFileSync(join(dir, "app-auth", "local-key"))
        return tokenFromRecord(record, undefined, {
          decrypt: (blob) => decryptLocalValue(blob, localKey),
        })
      }

      if (!safeStorageDecrypt) {
        if (platform === "win32") {
          const key = readMasterKey(root, dpapi ? { dpapi } : {})
          safeStorageDecrypt = (blob) => decryptSafeStorage(blob, key)
        } else if (platform === "darwin") {
          const pw = password ?? macSafeStoragePassword()
          safeStorageDecrypt = (blob) => decryptSafeStorageCbc(blob, pw, { iterations: 1003 })
        } else {
          const pw = password ?? linuxSafeStoragePassword()
          safeStorageDecrypt = (blob) => decryptSafeStorageCbc(blob, pw)
        }
      }

      return tokenFromRecord(record, undefined, { decrypt: safeStorageDecrypt })
    } catch (error) {
      errors.push(error?.message ?? String(error))
    }
  }
  throw new Error(
    `没有可导入的登录态：请确认已在桌面端登录过 TeleAgent${errors.length ? `（${errors.join("；")}）` : ""}`,
  )
}


