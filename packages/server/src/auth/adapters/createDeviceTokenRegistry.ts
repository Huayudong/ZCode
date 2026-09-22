/**
 * adapters 层：组合根——把默认 hasher / store / token 工厂与服务日志注入 app 核心编排。
 * 调用方（entry-http / 测试）只需提供文件路径。
 */
import { createServiceLogger } from "@zcode/services/node";
import { createDeviceTokenRegistryCore } from "../app/deviceTokenRegistry.js";
import type { DeviceTokenRegistryPort } from "../app/ports.js";
import { cryptoTokenFactory, sha256TokenHasher } from "./tokenCrypto.js";
import { createTokenFileStore } from "./tokenFileStore.js";

export function createDeviceTokenRegistry(options: {
  /** 记录文件完整路径；调用方用 getAppConfigDir() 解析，模块不依赖 services 的路径工具。 */
  filePath: string;
}): DeviceTokenRegistryPort {
  return createDeviceTokenRegistryCore({
    hasher: sha256TokenHasher,
    tokens: cryptoTokenFactory,
    store: createTokenFileStore(options.filePath),
    logger: createServiceLogger("server.auth"),
  });
}
