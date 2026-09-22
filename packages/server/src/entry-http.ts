import { join } from "node:path";
import { createLocalServices, getAppConfigDir } from "@zcode/services/node";
import {
  materializeBundledZCodeBuiltinProviderConfig,
  readBundledZCodeBuiltinProviderConfig,
} from "./bundledZCodeBuiltinProviderConfig.js";
import { createHttpServer } from "./http.js";
import {
  createDeviceTokenRegistry,
  type DeviceTokenRegistryPort,
} from "./auth/contract.js";
import { createPairingService, type PairingServicePort } from "./pairing/contract.js";

async function main(): Promise<void> {
  const zcodeBuiltinProviderConfigFilePath = await materializeBundledZCodeBuiltinProviderConfig({
    environmentConfigRoot: getAppConfigDir(),
    content: readBundledZCodeBuiltinProviderConfig(),
  });
  const port = Number(process.env["PORT"]) || 3030;
  const host = process.env["ZCODE_SERVER_HOST"]?.trim() || process.env["HOST"]?.trim() || undefined;
  const staticRoot = process.env["ZCODE_WEB_STATIC_ROOT"]?.trim() || undefined;
  const authToken = process.env["ZCODE_SERVER_AUTH_TOKEN"]?.trim() || undefined;
  const services = createLocalServices({
    zcodeBuiltinProviderConfigFilePath,
    providerProvisioningTargetEnabled: Boolean(authToken),
  });
  // 设备 token 表与配对服务只在鉴权已启用的 server 上接线：设备 token 扩展一个已鉴权
  // 的 server，不把默认开放的本机 dev server 变成"谁都无法访问"（auth spec §6 迁移边界）。
  let deviceTokenRegistry: DeviceTokenRegistryPort | undefined;
  let pairingService: PairingServicePort | undefined;
  if (authToken) {
    deviceTokenRegistry = createDeviceTokenRegistry({
      filePath: join(getAppConfigDir(), "access-tokens.json"),
    });
    pairingService = createPairingService({ deviceRegistry: deviceTokenRegistry });
  }

  createHttpServer(services, port, {
    ...(host ? { host } : {}),
    ...(staticRoot ? { staticRoot, spaFallback: true } : {}),
    ...(authToken ? { authToken, authRequired: true } : {}),
    ...(deviceTokenRegistry ? { deviceTokenRegistry } : {}),
    ...(pairingService ? { pairingService } : {}),
  });
}

void main().catch((error: unknown) => {
  console.error("[zcode-server:http] startup failed", error);
  process.exitCode = 1;
});
