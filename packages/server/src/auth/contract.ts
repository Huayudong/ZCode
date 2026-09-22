/**
 * server.auth 模块公开契约：设备 token 注册表与 HTTP 鉴权守卫。
 * 只允许从这里 import；实现细节（哈希、文件存储、凭证提取）都在模块内部。
 * 行为规范：docs/specs/harmony/auth.md。
 */
export { createDeviceTokenRegistry } from "./adapters/createDeviceTokenRegistry.js";
export { createTokenGuard, isTokenProtectedPath } from "./adapters/tokenGuard.js";
export { DEVICE_TOKEN_LIMITS, type DeviceTokenRecord } from "./domain/tokenRegistry.js";
export type {
  DeviceTokenRegistryPort,
  RegistryLogger,
  TokenFactory,
  TokenHasher,
  TokenRecordStore,
} from "./app/ports.js";
