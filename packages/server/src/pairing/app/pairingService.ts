/**
 * app 层：配对服务核心编排。
 * 状态唯一所有者：单活跃 pairCode（内存）+ claim 频控计数器（内存）。
 * 原子性关键：claim 的校验+消费在同步段完成（无 await 间隙），并发重放只有一个成功。
 * 行为规范：docs/specs/harmony/pairing.md §2/§3。
 */
import { constantTimeHexEqual, normalizeDeviceName, sha256TokenHasher } from "../../auth/contract.js";
import type { DeviceTokenRegistryPort, RegistryLogger } from "../../auth/contract.js";
import {
  PAIRING_LIMITS,
  isPairCodeExpired,
  type PairCodeRecord,
} from "../domain/pairingCodes.js";
import type {
  PairingClock,
  PairingRandom,
  PairingServicePort,
} from "./ports.js";
import { PairingCodeInvalidError, PairingRateLimitedError } from "./ports.js";

export interface CreatePairingServiceCoreOptions {
  /** 设备 token 注册表（server.auth 实例，注入而非复制）。 */
  deviceRegistry: DeviceTokenRegistryPort;
  clock: PairingClock;
  random: PairingRandom;
  logger: RegistryLogger;
}

export function createPairingServiceCore(
  options: CreatePairingServiceCoreOptions,
): PairingServicePort {
  const { deviceRegistry, clock, random, logger } = options;
  // 单活跃 pairCode：新签发作废旧码（spec §1）。
  let activeCode: PairCodeRecord | undefined;
  // pushToken 仅存内存（E5 消费），键为设备记录 id。
  const pushTokens = new Map<string, string>();
  // claim 频控：IP → 固定窗口计数。
  const claimBuckets = new Map<string, { count: number; windowStartMs: number }>();

  function checkClaimRateLimit(ip: string): PairingRateLimitedError | undefined {
    const nowMs = clock.nowMs();
    if (claimBuckets.size > PAIRING_LIMITS.maxTrackedIps) {
      claimBuckets.clear();
    }
    const bucket = claimBuckets.get(ip);
    if (!bucket || nowMs - bucket.windowStartMs >= PAIRING_LIMITS.claimWindowMs) {
      claimBuckets.set(ip, { count: 1, windowStartMs: nowMs });
      return undefined;
    }
    bucket.count += 1;
    if (bucket.count > PAIRING_LIMITS.claimMaxPerWindow) {
      return new PairingRateLimitedError(
        PAIRING_LIMITS.claimWindowMs - (nowMs - bucket.windowStartMs),
      );
    }
    return undefined;
  }

  return {
    async issueCode() {
      const pairCode = random.generatePairCode();
      const record: PairCodeRecord = {
        id: random.generateId(),
        codeHash: sha256TokenHasher.hash(pairCode),
        expiresAtMs: clock.nowMs() + PAIRING_LIMITS.ttlMs,
      };
      activeCode = record;
      logger.info("pairing code issued", record.id);
      return { pairCode, pairCodeId: record.id, expiresAtMs: record.expiresAtMs };
    },

    async claim(input) {
      // 频控先行（spec §2 事件顺序：频控检查 → 同步校验消费）。
      const limited = checkClaimRateLimit(input.clientIp);
      if (limited) {
        throw limited;
      }
      const deviceName = normalizeDeviceName(input.deviceName);
      if (!deviceName) {
        throw new PairingCodeInvalidError();
      }
      const pushToken = input.pushToken?.trim();
      if (pushToken && pushToken.length > PAIRING_LIMITS.maxPushTokenLength) {
        throw new PairingCodeInvalidError();
      }

      // 同步段：校验 + 消费（无 await 间隙，并发 claim 只有一个成功）。
      const record = activeCode;
      if (!record || isPairCodeExpired(record, clock.nowMs())) {
        throw new PairingCodeInvalidError();
      }
      if (!constantTimeHexEqual(record.codeHash, sha256TokenHasher.hash(input.pairCode))) {
        throw new PairingCodeInvalidError();
      }
      activeCode = undefined;

      // 异步段：签发设备 token；失败不回滚 pairCode（spec §4，用户重新出码）。
      const { token, record: issuedRecord } = await deviceRegistry.issue({ deviceName });
      if (pushToken) {
        pushTokens.set(issuedRecord.id, pushToken);
      }
      logger.info("device paired", issuedRecord.id, deviceName);
      return { accessToken: token, deviceName };
    },

    getPushToken(deviceId) {
      return pushTokens.get(deviceId);
    },
  };
}
