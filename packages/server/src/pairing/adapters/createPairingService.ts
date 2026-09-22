/**
 * adapters 层：组合根——注入 auth 注册表、时钟、CSPRNG 与服务日志。
 * 调用方（http.ts / 测试）只需提供 deviceRegistry。
 */
import { randomBytes, randomUUID } from "node:crypto";
import { createServiceLogger } from "@zcode/services/node";
import type { DeviceTokenRegistryPort, RegistryLogger } from "../../auth/contract.js";
import { createPairingServiceCore } from "../app/pairingService.js";
import type { PairingClock, PairingRandom, PairingServicePort } from "../app/ports.js";

const systemClock: PairingClock = {
  nowMs: () => Date.now(),
};

const cryptoRandom: PairingRandom = {
  /** 前缀 + 16 字节随机；明文只在出码响应中出现一次。 */
  generatePairCode(): string {
    return `zpc_${randomBytes(16).toString("hex")}`;
  },
  generateId(): string {
    return randomUUID();
  },
};

export function createPairingService(options: {
  deviceRegistry: DeviceTokenRegistryPort;
  logger?: RegistryLogger;
  /** 时钟/随机源可注入（测试 TTL 与频控窗口用）；缺省为系统实现。 */
  clock?: PairingClock;
  random?: PairingRandom;
}): PairingServicePort {
  return createPairingServiceCore({
    deviceRegistry: options.deviceRegistry,
    clock: options.clock ?? systemClock,
    random: options.random ?? cryptoRandom,
    logger: options.logger ?? createServiceLogger("server.pairing"),
  });
}
