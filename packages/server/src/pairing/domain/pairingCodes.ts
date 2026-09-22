/**
 * domain 层：pairCode 生命周期纯判定与请求 schema。
 * 禁止任何 IO / node: 依赖；随机生成与哈希在 adapters 完成。
 */
import { z } from "zod";

/** pairCode 记录。服务端只存 codeHash，明文只出现在出码响应与 claim 请求中。 */
export interface PairCodeRecord {
  id: string;
  /** SHA-256 hex（复用 auth 的 sha256TokenHasher）。 */
  codeHash: string;
  /** 毫秒时间戳（clock port 口径）。 */
  expiresAtMs: number;
}

export const PAIRING_LIMITS = {
  /** pairCode 有效期（spec §1：TTL 5 分钟）。 */
  ttlMs: 5 * 60_000,
  /** claim 频控固定窗口。 */
  claimWindowMs: 60_000,
  /** 窗口内每 IP claim 上限（含失败尝试）。 */
  claimMaxPerWindow: 10,
  /** 频控 IP 计数表硬上限，超出整体清空（防无界增长）。 */
  maxTrackedIps: 10_000,
  /** pushToken 长度上限；仅存内存（E5 消费），不落盘不入日志。 */
  maxPushTokenLength: 256,
} as const;

/** pairCode 是否已过期。消费语义由 app 层维护（活跃码被消费即清空）。 */
export function isPairCodeExpired(record: PairCodeRecord, nowMs: number): boolean {
  return record.expiresAtMs <= nowMs;
}

export const pairingClaimBodySchema = z.object({
  pairCode: z.string().trim().min(1),
  deviceName: z.string(),
  pushToken: z.string().optional(),
});

export type PairingClaimBody = z.infer<typeof pairingClaimBodySchema>;

export const pairingCodeBodySchema = z.object({}).strict();
