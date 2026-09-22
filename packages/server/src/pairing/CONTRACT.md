# server.pairing CONTRACT

移动端配对：一次性 pairCode 换设备 accessToken。行为规范：`docs/specs/harmony/pairing.md`。

## 不变量（类型无法表达的部分）

1. **pairCode 一次性**：claim 的校验+消费在同步段完成（无 await 间隙）；同一码并发 claim 恰好一个成功。服务端只存 `codeHash`（SHA-256 hex），明文只在出码响应与 claim 请求中出现。
2. **单活跃码**：`issueCode` 作废旧码；TTL 5 分钟（`PAIRING_LIMITS.ttlMs`）。
3. **无效码统一 401 不带原因**（`PairingCodeInvalidError` → 路由 401），防枚举。
4. **claim 频控**：每 IP 固定 60s 窗口 ≤10 次（含失败），超出 `PairingRateLimitedError` → 429 + `Retry-After`；计数表惰性重置、硬上限 10000 IP。
5. **pushToken 仅存内存**（`getPushToken(deviceId)` 供 E5 消费），不落盘、不入日志、重启即失。
6. **错误→状态码映射**（路由层）：`PairingCodeInvalidError`→401；`PairingRateLimitedError`→429；`DeviceTokenLimitError`（来自 auth）→409；其他签发失败→500（此时 pairCode 已消费，不回滚）。
7. `PAIRING_ADMIN_ONLY_PATHS` / `PAIRING_PUBLIC_PATHS` 必须与 `createTokenGuard` 的同名选项配套使用——鉴权分级由 auth 的守卫承担，路由自身不做二次鉴权判断。

## 公开面

- `createPairingService({ deviceRegistry })`：组合默认时钟/CSPRNG/日志的服务实例。
- `createPairingRoutes({ pairingService, deviceRegistry, serverIdentity })`：返回 Hono 子应用（含 code/claim/devices 四路由），由宿主 `app.route("/", …)` 挂载。
- `PAIRING_ADMIN_ONLY_PATHS` / `PAIRING_PUBLIC_PATHS`：guard 路径分级常量。
- 类型：`PairingServicePort`、`PairingServerIdentity`、`PAIRING_LIMITS` 等。
