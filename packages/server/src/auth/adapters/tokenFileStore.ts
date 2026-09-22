/**
 * adapters 层：设备 token 表的 JSON 文件持久化。
 * 只存 tokenHash，不存明文（auth spec §3.2）；原子写：临时文件 + rename，POSIX 下尽力 0600。
 */
import { mkdir, readFile, writeFile, rename, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { TokenStoreCorruptionError, type TokenRecordStore } from "../app/ports.js";
import type { DeviceTokenRecord } from "../domain/tokenRegistry.js";

const STORE_FORMAT_VERSION = 1;

interface StoredDocument {
  version: number;
  records: DeviceTokenRecord[];
}

export function createTokenFileStore(filePath: string): TokenRecordStore {
  async function load(): Promise<DeviceTokenRecord[]> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new TokenStoreCorruptionError(filePath);
    }
    const document = parsed as Partial<StoredDocument> | null;
    if (!document || document.version !== STORE_FORMAT_VERSION || !Array.isArray(document.records)) {
      throw new TokenStoreCorruptionError(filePath);
    }
    return document.records;
  }

  async function save(records: readonly DeviceTokenRecord[]): Promise<void> {
    const document: StoredDocument = { version: STORE_FORMAT_VERSION, records: [...records] };
    const payload = `${JSON.stringify(document, null, 2)}\n`;
    const tempPath = `${filePath}.tmp-${process.pid}`;
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(tempPath, payload, "utf8");
    try {
      // 0600 仅 POSIX 生效；Windows 无对应语义，失败静默忽略。
      await chmod(tempPath, 0o600);
    } catch {
      // 忽略：平台差异属预期。
    }
    await rename(tempPath, filePath);
  }

  return { load, save };
}
