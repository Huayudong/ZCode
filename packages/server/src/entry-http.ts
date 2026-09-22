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
import { resolveTlsMaterial, type TlsMaterial } from "./tls/contract.js";

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) {
    return true;
  }
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

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
  // TLS 材料三选一：显式 PEM → 自签 → 无（纯 HTTP）。解析失败 fail-fast 阻止启动（tls spec §1）。
  let tls: TlsMaterial | undefined;
  try {
    tls = await resolveTlsMaterial({
      certPath: process.env["ZCODE_SERVER_TLS_CERT"]?.trim() || undefined,
      keyPath: process.env["ZCODE_SERVER_TLS_KEY"]?.trim() || undefined,
      selfSigned: process.env["ZCODE_SERVER_TLS_SELF_SIGNED"] === "1",
      tlsDir: join(getAppConfigDir(), "tls"),
    });
  } catch (error) {
    console.error("[zcode-server:http] TLS 配置错误，启动中止：", (error as Error).message);
    process.exitCode = 1;
    return;
  }
  if (authToken && !isLoopbackHost(host) && !tls) {
    console.warn(
      "[zcode-server:http] 警告：server 监听非 loopback 地址但未启用 TLS，凭据将以明文传输。",
      "建议设置 ZCODE_SERVER_TLS_SELF_SIGNED=1 或提供 PEM（见 docs/harmony-networking.md）。",
    );
  }

  createHttpServer(services, port, {
    ...(host ? { host } : {}),
    ...(staticRoot ? { staticRoot, spaFallback: true } : {}),
    ...(authToken ? { authToken, authRequired: true } : {}),
    ...(deviceTokenRegistry ? { deviceTokenRegistry } : {}),
    ...(pairingService ? { pairingService } : {}),
    ...(tls ? { tls } : {}),
  });
}

void main().catch((error: unknown) => {
  console.error("[zcode-server:http] startup failed", error);
  process.exitCode = 1;
});
