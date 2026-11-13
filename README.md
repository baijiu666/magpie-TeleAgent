# magpie-TeleAgent — TeleAgent 星辰超级智能体 for magpie

把 [TeleAgent（星辰超级智能体，中国电信天翼 AI）](https://www.teleai.com.cn/product/teleagent)
接进 magpie：登录、签名、模型目录、积分余额、自动续期。

```
provider   teleagent（模型名 teleagent/<id>）
模型       智能（文本+图片）· 旗舰（仅文本）· 极速（文本+图片）
```

## 功能

- **两种登录**：天翼账号浏览器登录（插件开临时 Chrome/Edge，CDP 读 `operationToken`，
  不复制任何东西）；从本机桌面端一键导入（Windows / macOS / Linux，
  safeStorage / 钥匙串 / libsecret / local-key，只读一次）。
- **`superagent-auth-v1` 请求签名**：推理端点必需；业务端点只认 `X-Token`。
- **自动续期**：按 token **TTL 的一半**（上限 24 小时、最少 1 分钟）调 `POST /cowork/auth/token-refresh`（空 body）；实测续期返回 `expiresIn: 604799`（7 天），所以 7 天 TTL 会提前 24 小时续。优先采纳桌面端已续期的同账号新 token，避免轮转把桌面端顶掉。
- **动态模型目录**：登录后拉 `/api/v1/model-options`，跟随账号上下架；失败退回缓存 → 兜底表。
- **上下文长度跟随桌面端**：读账号的 `preset-context.json`，支持 200K / 400K / 600K / 800K / 1M，默认 400K。
- **请求清洗**：上游只认一小撮字段，多一个整包拒绝；`max_tokens` 统一封顶；
  可传 `reasoning_effort`（`low` 实测能把思维链降到 0，适合快速出代码）。
- **单轮 10 分钟**：官方桌面端给 20 分钟；插件取 10 分钟，长代码/推理任务不会被 150 秒掐死。
- **积分余额**：账号卡片只有一条 `积分` —— `9,096.71 / 9,100 积分`，和 WorkBuddy 的卡片一样；不再单独显示「余额」行，也不逐个积分包列出。
- **签到只在用量详情里**：`checkin` 钩子保留，用量详情面板有「自动签到 / 立即签到」；账号卡片列表不显示它们。
- **不误杀账号**：签名问题（40301/40104/40101）与套餐问题（403）带 `X-Magpie-Sign-In: kept`。

## 模型名：官方只暴露档位，底层模型不可见

服务端 `/api/v1/model-options` 只返回三个档位别名：`chat-pro`（智能）/
`chat-flagship`（旗舰）/ `chat-flash`（极速）。能试的入口都试过了，拿不到底层模型：

- `GET /api/v1/models`、`/v1/models` → 404
- `GET /api/v1/model-options?language=en-US` → 只有 Smart / Flagship / Flash
- 响应头只有 `x-request-id` / `x-trace-id`；响应体 `model` 原样回显别名
- `POST /api/v1/usage/token-records`、`GET /user/portal/usage/stats/record` →
  `model: "chat-flash"`、`modelLevel: "极速"`
- 引擎二进制里 `chat-pro` / `chat-flagship` 出现 0 次（`chat-flash` 只在示例会话数据里），
  没有「别名 → 真实模型」的映射表
- 网关甚至接受任意 `model` 字符串：`does-not-exist` 也返回 200（回落到默认后端），
  所以「跑通了」不能证明某个真实模型存在

客户端种子里另有 `chat-lite`（轻量，引擎内部小模型）和 `tele-safety-answer`
（安全审核模型），但账号目录不下发；`tele-safety-answer` 实测是安全兜底，不适合放进聊天列表。

模型列表只显示官方名称（**智能 / 旗舰 / 极速**）；真实 ID（`chat-pro` / `chat-flagship` / `chat-flash`）只用于内部请求，不再拼进显示名。

2026-11-13 补充核实：三档均曾自报 `Z.ai, GLM`，但旗舰重复身份题中又出现 `GLM-130B`、`GLM-4-6B`、`GLM-4.6`、`GLM-4` 以及 `Moonshot AI, Kimi`，说明自报版本不稳定。与 `GLM-5.3`、`GLM-5.3-Flash` 的 50 次同题对照显示短题行为相似，但行为相似不能证明同一底座。最终结论仍是 **GLM/Z.ai 有线索，具体版本不可定版**，详见 [docs/MODEL-IDENTITY.md](docs/MODEL-IDENTITY.md)。

## 思考模式（reasoning_effort）

设置页**没有**「思考模式」开关（`preset-context.json` 里只有 `contextLength`），
但网关支持按请求控制思考深度：`reasoning_effort` 只认 **low / high / max**；
`medium` / `minimal` / `none` / `auto` 都会回
`400 {"code":1210,"message":"该模型始终思考，不支持关闭思考；请使用 low、high 或 max。"}`。
`thinking: {"type":"enabled"}` 也接受（效果接近 max）；`thinking` 传字符串或 `disabled` 会被拒。

实测（chat-flash，同一 prompt，max_tokens 3000）：

| 参数 | 耗时 | reasoning tokens | content 字符 |
|---|---|---|---|
| 不传（上游默认） | 35.9s | 2074 | 408 |
| `reasoning_effort: "low"` | 3.5s | 0 | 374 |
| `reasoning_effort: "high"` | 5.2s | 19 | 462 |
| `reasoning_effort: "max"` | 21.4s | 1357 | 517 |
| `thinking: {"type":"enabled"}` | 24.7s | 1349 | 502 |

插件行为：

- 调用方（agent）传 `reasoning_effort` 时原样放行。
- 可设插件级默认档位：
  `magpie plugin options teleagent '{"reasoningEffort":"low"}'`
  （只接受 low/high/max；调用方显式传的值优先）。
- 不设默认就走上游默认（思考最久，适合复杂任务）。

## 续期实测（2026-11-11）

- 旧 token：`iat 1794399132` / `exp 1796904732`（29 天）/ `abs 1802175132`（90 天）
- 续期响应：`expiresIn: 604799`（≈ 7 天），`absoluteExpiresAt: null`
- 新 token：`iat 1794406065` / `exp 1795010865`（7 天）/ `abs 1802175132`（仍是原 90 天绝对期限）
- 续期后旧 token 打 `user_info` 仍返回 200（这次未观察到 60 秒吊销）；新 token 已写入 Magpie
- 因此 `refreshLead` 不能固定 1 小时：**7 天 TTL → 提前 24 小时；1 小时 TTL → 提前 30 分钟**
  （公式 `min(TTL / 2, 24h)`，最少 1 分钟）

## 图片输入（实测）

目录接口不返回 modality，下面是真机发图测出来的能力表（`src/provider.mjs` 的 `VISION_MODELS`）：

| 模型 | 图片 | 实测 |
|---|---|---|
| `chat-pro` | **支持** | 发 `pelican.png`，prompt_tokens 644，回答「白鸭子骑红色自行车」 |
| `chat-flagship` | **不支持** | prompt_tokens 48，回答「无法处理图片内容」 |
| `chat-flash` | **支持** | prompt_tokens 1273，回答「鹅/鸭骑红色自行车」 |

所以在 Magpie 里只有 `chat-pro` 和 `chat-flash` 会显示图片能力；`chat-flagship` 是纯文本。
新增模型/目录里没见过的新 ID 默认按纯文本处理，不猜。

## 登录

只有两种方式。桌面端 3.0.1 的登录窗是 Electron `BrowserWindow` + 导航拦截
（`did-navigate` 发现 `/cowork/auth?code=` 就把 code/token 取走）；Magpie 没有这个窗口，
而且官方回调只接受 teleai 域名（`callback/redirect?state=http://127.0.0.1…` 实测会被拒）。
所以浏览器登录不走回调地址，改成插件自己开一个临时 Chromium 窗口，用 CDP 读登录态。

### ① 浏览器登录（天翼账号）

插件启动一个**临时 profile 的 Chrome / Edge / Brave**，打开
`https://agent.teleai.com.cn/meter/teleagent-login/middle?redirect_url=…/teleagent`。
你在弹出的窗口里完成天翼账号登录；插件每 1 秒通过 CDP
`Network.getAllCookies` 读 `operationToken`（读不到再读 `localStorage` 的
`sso_token` / `console_token`），拿到后自动关闭浏览器并完成登录。

- **不用复制、不用粘、不用开 DevTools、没有回调地址和验证码。**
- 临时 profile 是全新的，所以每次要在弹出的窗口里登录一次；它不碰你平时的浏览器。
- 需要 Chromium 内核浏览器；没有的话报错，改用 ②。可用
  `MAGPIE_TELEAGENT_BROWSER=<exe>` 指定 Chrome/Edge 路径。
- 浏览器被安全软件拦调试端口时，改用 ②。

### ② 从本机桌面端导入（Windows / macOS / Linux）

数据根默认 `~/.local/share/TeleAgent`（桌面端 `TELEAI_DATA_ROOT` / 引擎
`TELEAGENT_DATA_DIR` 可覆盖），读 `current-owner.json` 指向的
`users/<owner>/app-auth/token.json`：

| 平台 | 解密 |
|---|---|
| Windows | `Local State` 的 DPAPI 主密钥 + AES-256-GCM（`v10`） |
| macOS | 钥匙串 `TeleAgent Safe Storage` 密码 + PBKDF2-SHA1(“saltysalt”, 1003) + AES-128-CBC |
| Linux | libsecret（`secret-tool`）或 basic_text `"peanuts"`；`v11` 迭代 1 次、`v10` 1003 次 + AES-128-CBC |
| Linux 无 keyring | `scheme:"local"` + `app-auth/local-key`（32 字节）+ AES-256-GCM |

**只读一次交给 magpie，不写回客户端、不落临时文件。** macOS 首次读钥匙串会弹系统授权；
Linux 读不到 libsecret 时可用环境变量 `TELEAGENT_SAFE_STORAGE_PASSWORD` 显式给密码。

## 额度

- **账号卡片**：只有一条 `积分` —— `9,096.71 / 9,100 积分`（余额 / 总额，和 WorkBuddy 卡片同形），
  不再单独显示「余额」行，也不逐个积分包/日期列出。
- **用量详情**：同一条 `积分` 窗口，加上「每天用掉的积分」和「自动签到 / 立即签到」。
- **签到**：`auth.checkin` 钩子保留（v3 活动 → `GET jump_url` → 重查 `completed`），
  但只出现在用量详情；账号卡片列表不显示「自动签到 / 立即签到」。
- 来源：`GET /user/portal/companyStore/userCenter` 的 `current_points_balance`，
  `GET /user/portal/points/detail` 的包总额/已用聚合。

## 并发上限

账号中心显示「并发任务上限 3」（`GET /user/portal/companyStore/userCenter`
的 `max_concurrent_tasks`）。插件按账号值来：

- 默认 / 兜底 **3**（`src/provider.mjs` 的 `DEFAULT_MAX_CONCURRENCY`，
  `package.json` 的 `magpie.maxConcurrency` 也是 3）；
- 登录时读一次 `userCenter`，把 `maxConcurrentTasks` 存进账号 metadata；
- `usage` 每次刷新时再同步一次，`auth.maxConcurrency` 用 getter 实时返回；
- 取失败或取到 3 → 就是 3；付费账号给 10 就用 10（上限 1000）。

## 安装

```bash
magpie plugin add github:baijiu666/magpie-TeleAgent
```

## 协议事实与证据

全部来自两处：本机安装包 **TeleAgent 3.0.1**（`D:\TeleAgent\resources\app.asar`）
与 2026-11-11 对上游的真机实测。

| 事实 | 证据 |
|---|---|
| base `https://agent.teleai.com.cn/superCowork/sapi`；推理 `POST …/api/v1/chat/completions` | asar 常量 `CBe()` / `go`；真机 200 |
| 用户身份走 `X-Token` | asar 的 `j8t()` / `j6()` 两处都只把用户 token 放这个头；真机业务 200 |
| 推理必须 `superagent-auth-v1` 签名 | 真机 A/B：只带 X-Token → `40104`；带签名 → 200（流式/非流式都通） |
| 签名算法 | 真机验证通过的实现，见 `src/client.mjs` 的 `canonicalRequest` / `derivedKey`；测试里有固定向量 |
| 业务面有两套头 | `userCenter` / `points/detail` 认 `X-SuperAgent-*`；`/api/v1/model-options` 还要 `X-Timestamp` / `X-Nonce` / `X-OS-Type`，缺了回 `40101` |
| 模型目录 `GET /api/v1/model-options?language=zh-CN` | asar 端点表 + 真机 200；`context_limit` 实测恒 null；**没有 modality/图片字段** |
| 图片输入：`chat-pro` / `chat-flash` 支持，`chat-flagship` 不支持 | 2026-11-11 真机发图实测（prompt_tokens 644 / 1273 vs 48） |
| 目录三档：chat-pro 智能(默认,x0.6) / chat-flagship 旗舰(x1.0) / chat-flash 极速(x0.2) | 真机 200 |
| 窗口跟随桌面端设置：200K / 400K / 600K / 800K / 1M（默认 400K）；输出 65536 | asar 的 `preset-context`（账号级 `preset-context.json`）与 `model-catalog.json` |
| 积分包 `GET /user/portal/points/detail` | 真机 200，与「积分到账」弹窗的子项逐条吻合 |
| 新人礼自动到账（首登/月度/邀请） | 真机积分包：`bp_act_newuser` / `bp_sys_monthly_basic` / `bp_referral_invitee` |
| 签到 v3 活动 + `jump_url` | asar 调用点 + 真机签到成功 |
| UA `opencode/1.2.27 ai-sdk/provider-utils/3.0.20 runtime/bun/1.3.10` | asar 里的引擎默认值 |
| UPMS `client_id=Z2veLLEHhZfq3hb5hWIwqJuPajIuasYi`；官方回调只接受 teleai 域名 | 本机 401 响应 + `callback/redirect?state=` 实测（127.0.0.1 被拒） |

**40301 / 40104 / 40101 都是头或签名问题**，不是版本过低 —— 改 `X-App-Version` 没有用。

## 已知限制

- **浏览器登录需要 Chromium 内核浏览器**（Chrome / Edge / Brave），而且用的是临时 profile：
  每次要在弹出的窗口里登录一次，不会复用你平时浏览器的登录态。安全软件拦调试端口时，
  插件会报「浏览器没有打开调试端口」，改用 ②。CDP 路径已在本机 Chrome 上验证
  （临时 profile + `Network.setCookie` 假 token → `chromiumLogin` 正确取回并解码）。
- **续期 TTL 是 7 天，不是 30 天**：新 token 只有 7 天；`refreshLead = min(TTL/2, 24h)`，7 天 → 提前 24 小时。代码里有轮转/60 秒吊销语义，但 2026-11-11 实测续期后旧 token 仍返回 200；仍按「旧 token 可能失效」处理。插件优先采纳桌面端已经续期的新 token，只有桌面端长期不运行、本地 token 不是更新时才走端点轮转。
- **`context_limit` 是 null**：窗口读桌面端的 `preset-context.json`
  （200K/400K/600K/800K/1M，默认 400K）；读不到才回退 400K。输出固定 65536。
- **`reasoning_content` 原样透传**：思考 token 也计入 `max_tokens`，`content` 为空是正常的。
- **图片能力按模型实测，不是目录字段**：`/api/v1/model-options` 没有 modality；2026-11-11 实测 `chat-pro` / `chat-flash` 能读图，`chat-flagship` 明确回「无法处理图片」。新增/未知模型保守为 false。
- **macOS 钥匙串 / Linux libsecret 未在本机实测**（开发机是 Windows）：解密算法用
  Electron safeStorage 标准参数实现，并用合成密文做了单元测试；真机首次导入若失败，
  按报错里的平台/后端提示处理，或设 `TELEAGENT_SAFE_STORAGE_PASSWORD`。

## 开发与验证

```bash
node --test          # 37 条：JWT / 设备身份 / 固定签名向量 / 请求清洗 /
                     # 空响应 / 浏览器发现+cookie 解析 / 三平台本机导入解密 /
                     # 积分明细 / 模型目录 / 签到
```

真机验收（2026-11-11）：

1. 本机导入取出 token，`user_info` 200，账号写入 magpie。
2. 动态目录拉到 3 档，名称、倍率、默认档与客户端一致。
3. `chat-flash` 非流式返回「收到」，流式 86 个 `data:` 帧 + `[DONE]`。
4. 账号卡片/用量只有一条积分：`9,096.71 / 9,100 积分`。
5. 签到控件在用量详情里，账号卡片不显示。
6. 真实编程任务：让 `chat-flash` + `reasoning_effort:"low"` 写「骑自行车的鹈鹕」单文件 HTML，
   27.2 秒 / 6154 字符，Chrome headless 渲染通过（白鹈鹕、橙喉囊、红色自行车、轮子/颠簸动画）。
   注：默认思维链很长时 150 秒会被 8000 max_tokens 全部吃掉，因此插件把上限放到 10 分钟，
   并允许 `reasoning_effort`。
7. 浏览器登录：本机 Chrome 临时 profile + CDP 实测（`Network.setCookie` 写入假
   `operationToken` → `chromiumLogin` 正确取回并解码），浏览器窗口与临时 profile 自动清理。
   真实天翼账号在弹窗里登录一次即可闭环。

## 免责声明

第三方插件，与 TeleAgent / 中国电信无隶属关系。只做协议转换，不提供模型服务；
请遵守厂商的服务条款。仓库内不含任何账号凭据或内置渠道密钥。
