/**
 * domain 层：证书材料纯计算（node-forge，无 node: 依赖）。
 * 指纹口径唯一：SHA-256(SPKI DER) hex 小写——server-info、配对响应、生成侧同源（tls spec §3.1）。
 */
import forge from "node-forge";

const SERVER_KEY_BITS = 2048;
const SERVER_VALIDITY_YEARS = 10;

export interface CertificateMaterial {
  certPem: string;
  keyPem: string;
}

/**
 * 生成自签服务器证书：CN=commonName，SAN=DNS+IP 条目，extendedKeyUsage=serverAuth。
 * 供局域网直连 + App 证书固定使用（非 CA，不签发下级证书）。
 */
export function generateSelfSignedServerCertificate(options: {
  commonName: string;
  /** SAN 条目；IP 地址原样作为 IP 条目，其余按 DNS 处理。 */
  altNames: readonly string[];
}): CertificateMaterial {
  const keys = forge.pki.rsa.generateKeyPair(SERVER_KEY_BITS);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  // 随机序列号转 hex；首字节清最高位避免被解析成负数。
  const serialBytes = forge.random.getBytesSync(16);
  let serialHex = bytesToHex(serialBytes);
  if (parseInt(serialHex.slice(0, 2), 16) & 0x80) {
    serialHex = `00${serialHex}`;
  }
  cert.serialNumber = serialHex;

  const notBefore = new Date();
  const notAfter = new Date(notBefore);
  notAfter.setFullYear(notAfter.getFullYear() + SERVER_VALIDITY_YEARS);
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;

  const attrs = [
    { name: "commonName", value: options.commonName },
    { name: "organizationName", value: "ZCode" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  const altNameEntries = options.altNames.map((value) =>
    isIpv4Address(value) ? { type: 7, ip: value } : { type: 2, value },
  );
  cert.setExtensions([
    { name: "basicConstraints", cA: false, critical: true },
    {
      name: "keyUsage",
      critical: true,
      digitalSignature: true,
      keyEncipherment: true,
    },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames: altNameEntries },
    { name: "subjectKeyIdentifier" },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

/** 证书公钥（SPKI DER）的 SHA-256 hex 指纹；与 node `X509Certificate.publicKey` 导出口径一致。 */
export function computeSpkiSha256Fingerprint(certPem: string): string {
  const cert = forge.pki.certificateFromPem(certPem);
  const spkiDer = forge.asn1.toDer(forge.pki.publicKeyToAsn1(cert.publicKey)).getBytes();
  const digest = forge.md.sha256.create();
  digest.update(spkiDer, "raw");
  return digest.digest().toHex();
}

function isIpv4Address(value: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(value);
}

function bytesToHex(bytes: string): string {
  let hex = "";
  for (let index = 0; index < bytes.length; index += 1) {
    hex += bytes.charCodeAt(index).toString(16).padStart(2, "0");
  }
  return hex;
}
