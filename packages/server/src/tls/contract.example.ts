/**
 * server.tls 契约使用示例：entry 形态解析 TLS 材料并起 HTTPS server。
 * 仅示范调用面，不参与运行时。
 */
import { join } from "node:path";
import { resolveTlsMaterial } from "./contract.js";

export async function resolveTlsExample(appConfigDir: string): Promise<string> {
  // 方式二：自签（生成-if-missing，幂等）。
  const tls = await resolveTlsMaterial({
    selfSigned: process.env["ZCODE_SERVER_TLS_SELF_SIGNED"] === "1",
    tlsDir: join(appConfigDir, "tls"),
    logger: console,
  });
  if (!tls) {
    return "http (no tls configured)";
  }
  return `https with fingerprint ${tls.certFingerprint}`;
}
