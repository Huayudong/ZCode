/**
 * server.pairing 模块清单：移动端配对（一次性 pairCode 换设备 accessToken）。
 * 依赖声明与 architecture-policy.yaml 保持一致；对外只暴露 contract.ts。
 * 行为规范：docs/specs/harmony/pairing.md。
 */
export const pairingModule = {
  id: "server.pairing",
  requires: ["server.auth"],
  provides: ["pairing-service", "pairing-routes"],
  publicEntrypoints: ["contract.ts"],
} as const;
