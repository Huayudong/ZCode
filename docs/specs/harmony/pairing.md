# Spec：移动端配对服务（E2 / PRD SRV-1）

| 项 | 内容 |
| --- | --- |
| 状态 | 草案已评审，实现排 Batch 2 |
| 对应计划 | `docs/PLAN-ZCode-Harmony.md` §4-E2；依赖 E1（`docs/specs/harmony/auth.md`）的设备 token 表 |
| 模块 | `server.pairing`（Batch 2 注册 managed 模块） |

## 1. 行为

桌面（Web UI 形态）出配对二维码 → 鸿蒙 App 扫码 → 一次性 pairCode 换取设备 accessToken，完成绑定。

### REST 契约（Batch 2 实现）

| 端点 | 鉴权 | 请求 | 响应 |
| --- | --- | --- | --- |
| `POST /api/pairing/code` | 管理员 token | `{}` | `{ url, pairCodeId, expiresAt, certFingerprint? }` |
| `POST /api/pairing/claim` | pairCode（body 携带） | `{ pairCode, deviceName, pushToken? }` | `{ accessToken, serverId, serverName?, certFingerprint? }` |
| `GET /api/pairing/devices` | 管理员 token | — | `{ devices: DeviceTokenRecord[] }`（复用 auth 模块记录） |
| `DELETE /api/pairing/devices/:id` | 管理员 token | — | `{ ok: true }`（吊销，透传 auth 模块） |

- 二维码 URL 契约：`zcode://pair?host=<host>&port=<port>&token=<pairCode>&name=<serverName>&fp=<certFingerprint?>`；`fp` 为自签证书 SPKI SHA-256 hex（E3 提供时携带）；各值 `encodeURIComponent`。
- `pairCode`：CSPRNG 随机、TTL 5 分钟、**一次性**（claim 成功或同 ID 重放均作废）；同一时刻未消费 pairCode 最多 1 个（新签发作废旧的）。
- `claim` 成功即调用 auth 模块 `issue({ deviceName })` 签发设备 accessToken；`pushToken` 字段本期仅存储透传给 E5（Push）预留，M1 无消费方。

## 2. 状态所有者

```text
pairCode 生命周期 → 唯一所有者：PairingService（server.pairing 模块，进程内存）
设备 accessToken  → 唯一所有者：server.auth 的 DeviceTokenRegistry（E1 已建）
所有者边界：pairing 只调用 auth 的 issue/list/revoke，不复制 token 表、不缓存 accessToken。
```

事件顺序（claim）：

```text
校验 pairCode 存在且未过期 → 原子消费（先标记 consumed 再签发，签发失败同样作废 pairCode）
  → auth.issue({ deviceName }) → 返回 accessToken
  → 成功日志（仅 pairCodeId + 设备名）
```

## 3. 不变量

1. pairCode 明文只出现在二维码 URL 与 claim 请求中；服务端只存 hash（复用 auth 的 hasher）。
2. 过期、已消费、不存在的 pairCode 统一返回 401 `{ error: "Invalid pairing code" }`（不区分原因，防枚举）。
3. 并发 claim 同一 pairCode：仅一个成功（消费先于签发的单线程许可内完成，Node 进程内无锁竞争）。
4. `deviceName` 校验同 auth spec §3.7（trim、≤64 字符、无控制字符）；空则 400。
5. claim 频控：同源（IP）每分钟 ≤10 次，超出 429（M1 简单计数器，进程内存）。
6. 配对管理端点仅管理员 token 可用（设备 token 调用返回 403）。

## 4. 失败语义

| 场景 | 行为 |
| --- | --- |
| auth.issue 落盘失败 | claim 返回 500 `{ error: "Failed to issue device token" }`，pairCode 已作废（用户需重新出码，避免半配对状态） |
| 二维码过期后再扫码 | 401（同 §3.2） |
| claim 时设备数超上限（auth §3.7 的 64） | 409 `{ error: "Device limit reached" }` |

## 5. 桌面 UI（packages/ui）

- `settings/MobilePairingSection.tsx` 新分区，按 `settingsNavigation.ts` → `SettingsPage.tsx` → 分区组件三步注册；
- 分区内：出码按钮（调 `POST /api/pairing/code`，需管理员 token——Web 形态下经既有 token cookie 天然具备）、二维码渲染（前端纯 JS 库）、倒计时与过期态、已配对设备列表（`GET /api/pairing/devices`，M2 完善吊销入口）；
- Web 端通过 `fetch` 直访 REST（与 `server-info` 同模式），不新增 RPC channel。

## 6. 迁移边界

- Electron 桌面设置页集成依赖 Q1 决策（Electron 形态不走 HTTP），本期范围外；`zcode://pair` 深链的桌面注册（`desktopDeepLinkUrl.ts` 增 host）随 Q1。
- `pushToken` 字段为 additive；E5 实现前 server 只透传存储于内存（不落盘）。

## 7. 验收场景（Batch 2 实现时落测试）

| # | 场景 | 期望 |
| --- | --- | --- |
| P1 | 管理员出码 → claim → 用 accessToken Bearer 访问 `/api/server-info` | 200 |
| P2 | 同一 pairCode 二次 claim | 401 |
| P3 | TTL 过期后 claim | 401 |
| P4 | 并发 10 个 claim 同码 | 恰 1 个 200 |
| P5 | 设备 token 调 `POST /api/pairing/code` | 403 |
| P6 | S1 场景全链路（App 端联调） | 扫码 3 秒内绑定并进入会话列表 |
