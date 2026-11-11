// 动态模型目录：GET /api/v1/model-options?language=zh-CN
//
// 返回 { data: { version, models: [{ model, display_name, is_default,
// points_multiplier, context_limit, description }] } }。
// `context_limit` 实测恒 null，窗口/输出由 provider.mjs 的预置值补齐。

import { CONTEXT_WINDOW, PATHS, VISION_MODELS, modelEntry } from "./provider.mjs"
import { getJson, unwrapBusiness } from "./client.mjs"

function rateOf(value) {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : ""
  if (!text) return undefined
  const n = Number(text)
  return Number.isFinite(n) && n > 0 ? `x${text}` : undefined
}

export function normalizeModel(raw, contextLength = CONTEXT_WINDOW) {
  const id = String(raw?.model ?? "").trim()
  if (!id) return undefined
  const display = String(raw?.display_name ?? "").trim() || id
  return modelEntry({
    id,
    // 模型列表只显示官方名称（智能/旗舰/极速），不把 ID 拼进去
    name: display,
    rate: rateOf(raw?.points_multiplier),
    description: raw?.description ? String(raw.description) : undefined,
    context: Number.isInteger(raw?.context_limit) && raw.context_limit > 0 ? raw.context_limit : contextLength,
    isDefault: raw?.is_default === true,
    // 目录没有 modality：按真机实测的模型能力表标注，未知模型保守为 false
    vision: VISION_MODELS.includes(id),
  })
}

export function modelMap(models, contextLength = CONTEXT_WINDOW) {
  const out = {}
  for (const raw of Array.isArray(models) ? models : []) {
    const entry = normalizeModel(raw, contextLength)
    if (entry) out[entry.id] = entry
  }
  return out
}

/** 失败抛错；成功但空表也抛（调用方退回缓存/兜底） */
export async function fetchCatalog({ token, identity, fetchImpl = fetch, language = "zh-CN", contextLength = CONTEXT_WINDOW }) {
  const data = unwrapBusiness(
    await getJson(`${PATHS.models}?language=${encodeURIComponent(language)}`, { token, identity, fetchImpl }),
    "读取模型目录",
  )
  const models = modelMap(data?.models, contextLength)
  if (Object.keys(models).length === 0) throw new Error("模型目录为空")
  return { version: String(data?.version ?? ""), models }
}
