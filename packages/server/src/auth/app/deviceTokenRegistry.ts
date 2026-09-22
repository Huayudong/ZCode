/**
 * app 层：设备 token 注册表核心编排。
 * 状态唯一所有者（内存缓存 + 唯一写路径），IO 全部经 ports；
 * 失败语义遵循 docs/specs/harmony/auth.md §4：验证 fail-closed，写失败拒绝变更。
 */
import {
  DEVICE_TOKEN_LIMITS,
  findActiveRecordByHash,
  normalizeDeviceName,
  type DeviceTokenRecord,
} from "../domain/tokenRegistry.js";
import type {
  DeviceTokenRegistryPort,
  RegistryLogger,
  TokenFactory,
  TokenHasher,
  TokenRecordStore,
} from "./ports.js";
import { DeviceTokenLimitError } from "./ports.js";

export interface CreateDeviceTokenRegistryCoreOptions {
  hasher: TokenHasher;
  store: TokenRecordStore;
  tokens: TokenFactory;
  logger: RegistryLogger;
  /** ISO 时间源，默认系统时钟；测试注入用。 */
  now?: () => string;
}

export function createDeviceTokenRegistryCore(
  options: CreateDeviceTokenRegistryCoreOptions,
): DeviceTokenRegistryPort {
  const { hasher, store, tokens, logger } = options;
  const now = options.now ?? (() => new Date().toISOString());
  let cache: DeviceTokenRecord[] | undefined;
  // 写队列：串行化 issue/revoke 的 load-modify-save，避免并发变更交错丢更新。
  let writeQueue: Promise<unknown> = Promise.resolve();

  async function ensureLoaded(): Promise<DeviceTokenRecord[]> {
    if (cache) {
      return cache;
    }
    try {
      cache = await store.load();
    } catch (error) {
      if (error instanceof Error && error.name === "TokenStoreCorruptionError") {
        // 表损坏按空表继续（与 settingService 容错一致），下次成功写入即覆写修复。
        logger.warn("device token store corrupted, starting from empty table", error.message);
        cache = [];
      } else {
        // 其余 IO 异常向上抛：verify 转 false（fail-closed），issue/revoke 拒绝。
        throw error;
      }
    }
    return cache;
  }

  function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = writeQueue.then(task, task);
    // 队列自身不吞错误：后续任务总在前一任务 settle 后执行。
    writeQueue = run.catch(() => undefined);
    return run;
  }

  return {
    async issue(input) {
      const deviceName = normalizeDeviceName(input.deviceName);
      if (!deviceName) {
        throw new Error("设备名不能为空");
      }
      return enqueueWrite(async () => {
        const records = await ensureLoaded();
        if (records.filter((record) => record.revokedAt === undefined).length >= DEVICE_TOKEN_LIMITS.maxRecords) {
          throw new DeviceTokenLimitError(DEVICE_TOKEN_LIMITS.maxRecords);
        }
        const token = tokens.generateToken();
        const record: DeviceTokenRecord = {
          id: tokens.generateId(),
          tokenHash: hasher.hash(token),
          deviceName,
          createdAt: now(),
        };
        records.push(record);
        try {
          await store.save(records);
        } catch (error) {
          records.pop();
          logger.error("failed to persist device token store", error);
          throw new Error("Failed to persist device token store");
        }
        logger.info("device token issued", record.id, deviceName);
        return { token, record };
      });
    },

    async verify(token) {
      if (!token) {
        return false;
      }
      let records: DeviceTokenRecord[];
      try {
        records = await ensureLoaded();
      } catch (error) {
        // fail-closed：存储不可用时不放行任何设备 token。
        logger.error("device token store unavailable, denying verify", error);
        return false;
      }
      const matched = findActiveRecordByHash(records, hasher.hash(token));
      if (!matched) {
        return false;
      }
      // lastUsedAt 尽力而为：不阻塞应答、失败仅 debug。
      const previous = matched.lastUsedAt;
      matched.lastUsedAt = now();
      void store.save(records).catch((error: unknown) => {
        matched.lastUsedAt = previous;
        logger.debug("failed to update lastUsedAt", matched.id, error);
      });
      return true;
    },

    async revoke(id) {
      return enqueueWrite(async () => {
        const records = await ensureLoaded();
        const record = records.find((entry) => entry.id === id);
        if (!record) {
          return false;
        }
        if (record.revokedAt !== undefined) {
          return true;
        }
        record.revokedAt = now();
        try {
          await store.save(records);
        } catch (error) {
          record.revokedAt = undefined;
          logger.error("failed to persist revocation", error);
          return false;
        }
        logger.info("device token revoked", record.id);
        return true;
      });
    },

    async list() {
      const records = await ensureLoaded();
      return records.map((record) => ({ ...record }));
    },
  };
}
