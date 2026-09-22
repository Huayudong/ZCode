/**
 * server.pairing 模块公开契约：配对服务与 REST 路由。
 * 只允许从这里 import；实现细节（pairCode 生命周期、频控、路由注册）都在模块内部。
 * 行为规范：docs/specs/harmony/pairing.md。
 */
export { createPairingService } from "./adapters/createPairingService.js";
export {
  PAIRING_ADMIN_ONLY_PATHS,
  PAIRING_PUBLIC_PATHS,
  createPairingRoutes,
  type PairingServerIdentity,
} from "./adapters/pairingRoutes.js";
export { PAIRING_LIMITS, type PairCodeRecord } from "./domain/pairingCodes.js";
export {
  PairingCodeInvalidError,
  PairingRateLimitedError,
  type PairingServicePort,
} from "./app/ports.js";
