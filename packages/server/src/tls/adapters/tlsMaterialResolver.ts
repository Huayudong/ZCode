/**
 * adapters 层：TLS 材料解析（env/文件 → PEM → 指纹）与自签证书文件管理。
 * 失败语义（tls spec §3.2）：显式配置失败 fail-fast 抛错；自签幂等（存在即复用）。
 */
import { hostname, networkInterfaces } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CertificateMaterial } from "../domain/certificateMaterial.js";
import {
  computeSpkiSha256Fingerprint,
  generateSelfSignedServerCertificate,
} from "../domain/certificateMaterial.js";

export interface TlsMaterial {
  certPem: string;
  keyPem: string;
  /** SPKI SHA-256 hex 小写；server-info / 配对响应 / QR `fp` 同源。 */
  certFingerprint: string;
}

export interface TlsLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

export interface ResolveTlsMaterialOptions {
  /** 用户提供 PEM（方式一）；提供其一必须两者齐备。 */
  certPath?: string;
  keyPath?: string;
  /** 自签模式（方式二）：目录内生成-if-missing。 */
  selfSigned?: boolean;
  /** 自签证书目录（调用方传 <appConfigDir>/tls）。 */
  tlsDir?: string;
  logger?: TlsLogger;
}

/**
 * 解析 TLS 材料；未配置任何方式时返回 undefined（维持纯 HTTP）。
 */
export async function resolveTlsMaterial(
  options: ResolveTlsMaterialOptions,
): Promise<TlsMaterial | undefined> {
  const certPath = options.certPath?.trim() || undefined;
  const keyPath = options.keyPath?.trim() || undefined;
  if (certPath || keyPath) {
    if (!certPath || !keyPath) {
      throw new Error(
        `TLS 配置不完整：ZCODE_SERVER_TLS_CERT 与 ZCODE_SERVER_TLS_KEY 必须同时提供（cert=${certPath ?? "缺"}, key=${keyPath ?? "缺"}）`,
      );
    }
    let certPem: string;
    let keyPem: string;
    try {
      certPem = readFileSync(certPath, "utf8");
      keyPem = readFileSync(keyPath, "utf8");
    } catch (error) {
      throw new Error(
        `TLS PEM 文件读取失败：${(error as Error).message}`,
      );
    }
    return {
      certPem,
      keyPem,
      certFingerprint: computeSpkiSha256Fingerprint(certPem),
    };
  }

  if (options.selfSigned && options.tlsDir) {
    const certPath = join(options.tlsDir, "server-cert.pem");
    const keyPath = join(options.tlsDir, "server-key.pem");
    const material = ensureSelfSignedFiles(certPath, keyPath, options.logger);
    return {
      certPem: material.certPem,
      keyPem: material.keyPem,
      certFingerprint: computeSpkiSha256Fingerprint(material.certPem),
    };
  }

  return undefined;
}

/** 幂等：证书与私钥都存在时直接复用（tls spec §3.3），否则生成并落盘（私钥 0600）。 */
function ensureSelfSignedFiles(
  certPath: string,
  keyPath: string,
  logger: TlsLogger | undefined,
): CertificateMaterial {
  if (existsSync(certPath) && existsSync(keyPath)) {
    try {
      const material = { certPem: readFileSync(certPath, "utf8"), keyPem: readFileSync(keyPath, "utf8") };
      logger?.info("self-signed server certificate reused", certPath);
      return material;
    } catch (error) {
      // 读取失败（含被加密驱动损坏）时重新生成，避免卡死启动。
      logger?.warn("self-signed certificate unreadable, regenerating", (error as Error).message);
    }
  }
  const material = generateSelfSignedServerCertificate({
    commonName: hostname() || "zcode-server",
    altNames: collectLocalAltNames(),
  });
  mkdirSync(dirname(certPath), { recursive: true });
  writeFileSync(certPath, material.certPem, { mode: 0o644 });
  writeFileSync(keyPath, material.keyPem, { mode: 0o600 });
  logger?.info("self-signed server certificate generated", certPath);
  return material;
}

/** SAN 条目：主机名 + 全部非内部 IPv4（跨设备可达地址）。 */
function collectLocalAltNames(): string[] {
  const names = new Set<string>();
  const host = hostname();
  if (host) {
    names.add(host);
  }
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const entry of interfaces ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        names.add(entry.address);
      }
    }
  }
  return [...names];
}
