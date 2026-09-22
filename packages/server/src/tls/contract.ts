/**
 * server.tls 模块公开契约：TLS 材料解析与自签证书。
 * 只允许从这里 import；实现细节（forge 生成、文件 IO）都在模块内部。
 * 行为规范：docs/specs/harmony/tls.md。
 */
export { resolveTlsMaterial, type ResolveTlsMaterialOptions, type TlsLogger, type TlsMaterial } from "./adapters/tlsMaterialResolver.js";
export {
  computeSpkiSha256Fingerprint,
  generateSelfSignedServerCertificate,
  type CertificateMaterial,
} from "./domain/certificateMaterial.js";
