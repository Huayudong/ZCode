# server.auth CONTRACT

多设备访问 token 表与 HTTP 鉴权守卫。行为规范：`docs/specs/harmony/auth.md`。

## 不变量（类型无法表达的部分）

1. **Fail-closed**：`DeviceTokenRegistryPort.verify` 在任何存储异常下返回 `false`，不 reject、不抛错；中间件据此拒绝请求。
2. **明文 token 不落盘、不入日志**：持久化文档只含 `tokenHash`（SHA-256 hex）；日志仅出现记录 id 与设备名。
3. **唯一写路径**：`issue` / `revoke` 经内部写队列串行执行；写入失败时内存态回滚（issue 弹栈、revoke 清除 revokedAt），不留半变更。
4. **吊销幂等**：对已吊销记录再次 `revoke` 返回 `true`；不存在返回 `false`。
5. **损坏容错**：表文件 JSON 非法或缺 `version` 字段时按空表继续（warn 一次），下次成功写入覆写修复。
6. `createTokenGuard` 在管理员 token 与注册表均为空时返回 `undefined`（语义=服务无鉴权），调用方据此跳过中间件注册。
7. 表文件格式版本 `version: 1`；字段演进必须兼容旧版本读取或走显式迁移。

## 公开面

- `createDeviceTokenRegistry({ filePath })`：组合默认 hasher/store/工厂的注册表实例。
- `createTokenGuard({ adminToken?, deviceTokenRegistry? })`：Hono 中间件；返回 `undefined` 表示未配置鉴权。
- `isTokenProtectedPath(pathname)`：`/api/*`、`/ws`、`/ws/*` 保护面判定（http.ts 的 SPA fallback 复用）。
- 类型：`DeviceTokenRegistryPort`、`DeviceTokenRecord`、`DEVICE_TOKEN_LIMITS` 等。
