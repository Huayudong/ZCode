/**
 * server.tls 模块清单：局域网 HTTPS 的 TLS 材料解析与自签证书。
 * 依赖声明与 architecture-policy.yaml 保持一致；对外只暴露 contract.ts。
 * 行为规范：docs/specs/harmony/tls.md。
 */
export const tlsModule = {
  id: "server.tls",
  requires: [],
  provides: ["tls-material-resolver", "self-signed-certificate"],
  publicEntrypoints: ["contract.ts"],
} as const;
