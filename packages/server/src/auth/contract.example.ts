/**
 * server.auth 契约使用示例：在 entry 形态中接线注册表与 HTTP 守卫。
 * 仅示范调用面，不参与运行时。
 */
import { createDeviceTokenRegistry, createTokenGuard } from "./contract.js";

export async function wireServerAuthExample(
  adminToken: string | undefined,
  accessTokensFilePath: string,
): Promise<ReturnType<typeof createTokenGuard>> {
  const deviceTokenRegistry = createDeviceTokenRegistry({ filePath: accessTokensFilePath });
  const { token } = await deviceTokenRegistry.issue({ deviceName: "example-phone" });
  // token 只在此处出现一次，交给设备安全存储；服务端此后只保留哈希。
  console.log(`issued device token for example-phone: ${token.length} chars`);
  return createTokenGuard({ adminToken, deviceTokenRegistry });
}
