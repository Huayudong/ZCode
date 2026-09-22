/**
 * server.pairing 契约使用示例：在 entry 形态接线配对服务与路由。
 * 仅示范调用面，不参与运行时。
 */
import {
  createDeviceTokenRegistry,
  createTokenGuard,
  isTokenProtectedPath,
} from "../auth/contract.js";
import {
  PAIRING_ADMIN_ONLY_PATHS,
  PAIRING_PUBLIC_PATHS,
  createPairingRoutes,
  createPairingService,
} from "./contract.js";

export async function wirePairingExample(options: {
  adminToken: string;
  accessTokensFilePath: string;
  serverId: string;
}): Promise<void> {
  const deviceTokenRegistry = createDeviceTokenRegistry({
    filePath: options.accessTokensFilePath,
  });
  const pairingService = createPairingService({ deviceRegistry: deviceTokenRegistry });
  const guard = createTokenGuard({
    adminToken: options.adminToken,
    deviceTokenRegistry,
    adminOnlyPaths: PAIRING_ADMIN_ONLY_PATHS,
    publicPaths: PAIRING_PUBLIC_PATHS,
  });
  if (!guard) {
    throw new Error("unreachable: admin token configured");
  }
  const routes = createPairingRoutes({
    pairingService,
    deviceRegistry: deviceTokenRegistry,
    serverIdentity: { serverId: options.serverId },
  });
  // routes 交给宿主 Hono app 挂载；isTokenProtectedPath 供 SPA fallback 排除。
  console.log(Boolean(routes), isTokenProtectedPath("/api/pairing/claim"));
}
