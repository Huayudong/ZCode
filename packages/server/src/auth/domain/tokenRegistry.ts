/**
 * domain 层：设备 token 记录与纯判定逻辑。
 * 禁止任何 IO / node: 依赖；哈希计算与落盘在 adapters 完成。
 */

/** 设备 token 记录。持久化与查询只使用 tokenHash，明文 token 不落盘。 */
export interface DeviceTokenRecord {
  /** 稳定标识，用于吊销与日志，不含凭证语义。 */
  id: string;
  /** SHA-256 hex。 */
  tokenHash: string;
  deviceName: string;
  /** ISO 8601。 */
  createdAt: string;
  /** ISO 8601，尽力而为更新，不参与判定。 */
  lastUsedAt?: string;
  /** ISO 8601，存在即已吊销。 */
  revokedAt?: string;
}

export const DEVICE_TOKEN_LIMITS = {
  /** 活跃记录上限，超出后签发失败（防无界增长）。 */
  maxRecords: 64,
  /** 设备名长度上限。 */
  maxDeviceNameLength: 64,
} as const;

/** 规范化设备名：trim、剔除控制字符、超长截断为拒绝依据（空名返回空串）。 */
export function normalizeDeviceName(raw: string): string {
  // \u0000-\u001f 与 \u007f 覆盖常见控制字符，防止日志/JSON 注入
  const stripped = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return stripped.slice(0, DEVICE_TOKEN_LIMITS.maxDeviceNameLength);
}

/** 记录是否仍可鉴权（未吊销）。 */
export function isActiveRecord(record: DeviceTokenRecord): boolean {
  return record.revokedAt === undefined;
}

/**
 * 常量时间十六进制比较：遍历长度取双方最大值，避免时序侧信道泄露前缀匹配长度。
 * 两侧输入统一小写（hasher 输出小写 hex；防御性处理调用方大小写）。
 */
export function constantTimeHexEqual(a: string, b: string): boolean {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i += 1) {
    diff |= (left.charCodeAt(i) | 0) ^ (right.charCodeAt(i) | 0);
  }
  return diff === 0;
}

/** 在记录集中查找与 tokenHash 匹配且未吊销的记录；找不到返回 undefined。 */
export function findActiveRecordByHash(
  records: readonly DeviceTokenRecord[],
  tokenHash: string,
): DeviceTokenRecord | undefined {
  return records.find((record) => isActiveRecord(record) && constantTimeHexEqual(record.tokenHash, tokenHash));
}
