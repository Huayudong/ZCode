/**
 * server.auth 模块清单：HTTP/WS 访问鉴权的多设备 token 表。
 * 依赖声明与 architecture-policy.yaml 保持一致；对外只暴露 contract.ts。
 * 行为规范：docs/specs/harmony/auth.md。
 */
export const authModule = {
  id: "server.auth",
  requires: ["shared", "services"],
  provides: ["device-token-registry", "token-guard"],
  publicEntrypoints: ["contract.ts"],
} as const;
