/**
 * app 层端口：deviceTokenRegistry 只依赖这些接口，IO 由 adapters 实现并在组合根注入。
 * 领域类型从 domain 层引入；端口不携带任何 node: 语义。
 */
import type { DeviceTokenRecord } from "../domain/tokenRegistry.js";

/** token 哈希器。实现必须对小写 hex 输出保持稳定（domain 用常量时间比较）。 */
export interface TokenHasher {
  hash(token: string): string;
}

/** 记录持久化端口。load 对不存在的文件返回空数组；损坏格式抛 TokenStoreCorruptionError。 */
export interface TokenRecordStore {
  load(): Promise<DeviceTokenRecord[]>;
  save(records: readonly DeviceTokenRecord[]): Promise<void>;
}

/** 随机凭证与记录 id 的生成端口（CSPRNG 实现在 adapters）。 */
export interface TokenFactory {
  generateToken(): string;
  generateId(): string;
}

/** 结构化日志端口，避免 app 层直接依赖具体 logger 实现。 */
export interface RegistryLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** 设备 token 注册表对外端口（契约面，见 contract.ts）。 */
export interface DeviceTokenRegistryPort {
  /** 签发新设备 token。明文仅在返回值中出现一次；写入失败时拒绝并保持原表不变。 */
  issue(input: { deviceName: string }): Promise<{ token: string; record: DeviceTokenRecord }>;
  /** 校验明文 token 是否命中活跃记录。任何失败一律返回 false（fail-closed），不 reject。 */
  verify(token: string): Promise<boolean>;
  /** 吊销记录。记录不存在返回 false；已吊销视为成功；落盘失败返回 false。 */
  revoke(id: string): Promise<boolean>;
  /** 全量记录快照（含已吊销，供管理端展示）。 */
  list(): Promise<DeviceTokenRecord[]>;
}

/** 表文件损坏（可解析性失败）；调用方按空表继续并在下次写入覆写。 */
export class TokenStoreCorruptionError extends Error {
  constructor(public readonly filePath: string) {
    super(`Device token store is corrupted: ${filePath}`);
    this.name = "TokenStoreCorruptionError";
  }
}
