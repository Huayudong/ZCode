/**
 * adapters 层：token 哈希与随机凭证生成（node:crypto CSPRNG）。
 * 哈希输出固定小写 hex，供 domain 常量时间比较。
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { TokenFactory, TokenHasher } from "../app/ports.js";

export const sha256TokenHasher: TokenHasher = {
  hash(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
  },
};

export const cryptoTokenFactory: TokenFactory = {
  /** 前缀 + 24 字节随机，明文 token 只在签发响应中出现一次。 */
  generateToken(): string {
    return `zcd_${randomBytes(24).toString("hex")}`;
  },
  generateId(): string {
    return randomUUID();
  },
};
