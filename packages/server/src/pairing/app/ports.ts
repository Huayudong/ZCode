/**
 * app 层端口：pairingService 只依赖这些接口，IO/随机数由 adapters 实现注入。
 * 设备 token 签发复用 server.auth 的注册表契约（跨模块仅经其 contract.ts 公开入口）。
 */

/** 毫秒时钟。 */
export interface PairingClock {
  nowMs(): number;
}

/** CSPRNG 随机源：pairCode 与记录 id。 */
export interface PairingRandom {
  generatePairCode(): string;
  generateId(): string;
}

/** 配对服务端口（契约面，见 contract.ts）。 */
export interface PairingServicePort {
  /** 签发一次性 pairCode（新签发作废旧码）。明文只在返回值出现，服务端仅存 hash。 */
  issueCode(): Promise<{ pairCode: string; pairCodeId: string; expiresAtMs: number }>;
  /**
   * 用一次性 pairCode 换设备 accessToken。clientIp 用于 claim 频控（spec §3.5）。
   * 任何失败一律抛 PairingCodeInvalidError / PairingRateLimitedError /
   * DeviceTokenLimitError（透传），不静默。
   */
  claim(input: {
    pairCode: string;
    deviceName: string;
    pushToken?: string;
    clientIp: string;
  }): Promise<{
    accessToken: string;
    deviceName: string;
  }>;
  /** 读取设备上报的 pushToken（E5 Push 消费）；仅内存，重启即失。 */
  getPushToken(deviceId: string): string | undefined;
}

/** pairCode 无效/过期/已消费——统一错误，路由映射 401（防枚举，不带原因）。 */
export class PairingCodeInvalidError extends Error {
  constructor() {
    super("Invalid pairing code");
    this.name = "PairingCodeInvalidError";
  }
}

/** claim 频控超限；路由映射 429 + Retry-After。 */
export class PairingRateLimitedError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super("Too many pairing attempts");
    this.name = "PairingRateLimitedError";
  }
}
