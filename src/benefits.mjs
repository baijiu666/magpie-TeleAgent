// 积分与签到：余额、积分包明细、积分福利社 v3 的活动与领取。

import { PATHS } from "./provider.mjs"
import { ApiError, CODES } from "./errors.mjs"
import { getJson, unwrapBusiness } from "./client.mjs"

/** 可领取的 action_status（3.0.1 的活动状态机） */
export const CLAIMABLE = Object.freeze(["incomplete", "not_joined", "fixed"])

/** 数字 / 数字字符串都认；空串不算 0 */
export function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value !== "string") return undefined
  const text = value.trim()
  if (!text) return undefined
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : undefined
}

function payload(json) {
  const data = json?.data
  return data !== null && typeof data === "object" && !Array.isArray(data) ? data : json
}

/** 余额与套餐名 */
export async function fetchPoints({ token, identity, fetchImpl = fetch }) {
  const data = payload(unwrapBusiness(await getJson(PATHS.points, { token, identity, fetchImpl }), "读取积分余额"))
  return {
    balance: toNumber(data?.current_points_balance),
    plan: String(data?.plan_display_name ?? "").trim(),
    maxConcurrentTasks: toNumber(data?.max_concurrent_tasks),
    welfareEnabled: data?.welfare_club_enabled === true,
  }
}

/** 积分包：每个都有总额/已用/余额/到期时间；新人礼是其中的子项 */
export async function fetchPackages({ token, identity, fetchImpl = fetch }) {
  const data = payload(unwrapBusiness(await getJson(PATHS.pointsDetail, { token, identity, fetchImpl }), "读取积分明细"))

  const packages = []
  for (const group of Array.isArray(data?.groups) ? data.groups : []) {
    for (const item of [...(group?.active ?? []), ...(group?.invalid ?? [])]) {
      const subs = Array.isArray(item?.subItems) && item.subItems.length > 0 ? item.subItems : [item]
      for (const sub of subs) {
        const totalQuota = toNumber(sub?.totalQuota) ?? 0
        const balance = toNumber(sub?.balance) ?? 0
        packages.push({
          name: String(sub?.name ?? item?.name ?? "积分").trim() || "积分",
          totalQuota,
          usedQuota: toNumber(sub?.usedQuota) ?? Math.max(0, totalQuota - balance),
          balance,
          effectiveEnd: String(sub?.effectiveEnd ?? item?.effectiveEnd ?? ""),
          expired: sub?.isExpired === true || item?.isExpired === true,
        })
      }
    }
  }
  return { balance: toNumber(data?.pointsBalance), packages }
}

/** 北京时间字符串 → ISO（magpie 只认 ISO / 数字） */
export function beijingIso(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/u.exec(String(text ?? "").trim())
  if (!m) return undefined
  const date = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/** 积分福利社 v3：activity_data[] 每项带 action_status / action_type / jump_url */
export async function fetchWelfare({ token, identity, fetchImpl = fetch, theme = "light" }) {
  const data = payload(unwrapBusiness(
    await getJson(`${PATHS.welfare}?theme=${encodeURIComponent(theme)}`, { token, identity, fetchImpl }),
    "读取积分福利社",
  ))
  return data && typeof data === "object" ? data : undefined
}

/** 取可操作的 api 活动（网页活动 action_type=web，不代点） */
export function dailyActivity(welfare) {
  const list = Array.isArray(welfare?.activity_data) ? welfare.activity_data : []
  return list
    .filter((a) => a && a.visible !== false && a.action_type === "api")
    .sort((a, b) => Number(b.is_main_activity) - Number(a.is_main_activity))[0]
}

export function isClaimable(activity) {
  return CLAIMABLE.includes(String(activity?.action_status ?? ""))
}

/** 从活动文案里读「每日可领 N 积分」；读不到就返回 undefined，不编数字 */
export function dailyPoints(activity) {
  const html = `${activity?.activity_title ?? ""} ${activity?.activity_subtitle ?? ""}`
  const match =
    /每日可领[\s\S]{0,200}?>\s*([\d,]+(?:\.\d+)?)\s*</u.exec(html)
    ?? /每日可领[^\d]{0,30}([\d,]+(?:\.\d+)?)/u.exec(html)
  const value = toNumber(match?.[1]?.replace(/,/gu, ""))
  return value !== undefined && value > 0 ? value : undefined
}

/** 领取 = GET 活动给的 jump_url（去掉网关前缀） */
export async function claimActivity(activity, { token, identity, fetchImpl = fetch }) {
  const raw = String(activity?.jump_url ?? "").trim()
  if (!raw) throw new ApiError("签到活动没有 jump_url", { status: 502, code: CODES.upstreamError })
  if (String(activity?.action_type ?? "") === "web") {
    throw new ApiError("这是网页活动，插件不代点", { status: 502, code: CODES.upstreamError })
  }

  let path = raw
  try {
    const url = new URL(raw)
    path = `${url.pathname}${url.search}`
  } catch {}
  path = path.replace(/^\/superCowork\/sapi/u, "")

  const result = await getJson(path, { token, identity, fetchImpl })
  unwrapBusiness(result, "领取每日积分")
}

export function formatPoints(value) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(Number(value) || 0)
}
