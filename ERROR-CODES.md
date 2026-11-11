# 错误码（v1）

所有错误出口走 `src/errors.mjs` 的 `errorResponse()`，形状固定：

```json
{ "error": { "message": "…", "type": "upstream_error", "code": "…", "status": 401 } }
```

## 词表（冻结）

| code | 典型 status | 什么时候用 | 宿主会做什么 |
|---|---|---|---|
| `sign_in_required` | 401 | 还没登录、浏览器/本机导入拿到的 token 被上游拒绝 | 标记账号需要登录 |
| `session_expired` | 401 | 上游 401/403，或业务/推理面返回登录页 HTML | 标记账号需要重新登录 |
| `signing_error` | 401 + `X-Magpie-Sign-In: kept` | 上游 `40301` / `40104`：**签名实现不一致，不是账号问题** | **不**标记账号 |
| `invalid_request` | 400 | 请求体不是合法 JSON | 客户端自己修 |
| `model_not_found` | 404 | 上游 404 | 只搁置这个模型 |
| `rate_limited` | 429 | 上游 429 | 换号 / 退避 |
| `upstream_unavailable` | 502 / 503 | 上游 HTML 错误页、非流式空响应重试后仍空 | 可重试 |
| `upstream_timeout` | 504 | 整轮 150 秒墙钟或调用方 abort | 可重试 |
| `upstream_error` | 402 / 403 / 其它 | 业务错误；403（套餐）带 `kept` | 403 不标记账号 |
| `not_implemented` | 501 | 不支持的端点 | 只影响该端点 |
| `internal_error` | 502 | 插件自身异常 | 请求失败 |

## 四条规矩

1. **每个出口都带 `status` + `code` + 保留上游原文的 `message`**，否则用户只能看到「服务异常」。
2. **模型级错误不用 401、不用 404 以外的 4xx** —— 401 会被宿主当成登录失效，把整个账号摘掉。
3. **不是登录问题的 401/403 必须带 `X-Magpie-Sign-In: kept`**：
   - `40301` / `40104` → 签名问题（改签名，不要改版本号）
   - 403 套餐/额度限制
4. **不支持的端点用 501**，绝不能用 404（会被当成「模型不存在」只搁置模型）。

## 新增错误码

先改本文件，再改 `src/errors.mjs` 的 `CODES`，并在 `tests/teleagent.test.mjs`
里补一条断言。码表是冻结的：改名会让宿主与日志里的历史记录对不上。
