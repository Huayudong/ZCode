// node-forge 1.4.0 没有自带类型，也未安装 @types/node-forge。
// 这里只声明 server.tls 用到的最小子集（自签证书生成 / PEM 解析 / SPKI 指纹），避免引入额外依赖。
declare module "node-forge" {
  interface ForgeKey {
    n?: unknown;
  }
  interface ForgeKeyPair {
    publicKey: ForgeKey;
    privateKey: ForgeKey;
  }
  interface ForgeCertAttr {
    name?: string;
    shortName?: string;
    type?: string;
    value?: string;
  }
  interface ForgeCertExtension {
    name: string;
    cA?: boolean;
    critical?: boolean;
    keyCertSign?: boolean;
    cRLSign?: boolean;
    digitalSignature?: boolean;
    keyEncipherment?: boolean;
    serverAuth?: boolean;
    subjectAltName?: Array<{ type: number; value?: string; ip?: string }>;
    altNames?: Array<{ type: number; value?: string; ip?: string }>;
    subjectKeyIdentifier?: boolean;
  }
  interface ForgeASN1 {
    getBytes(): string;
  }
  interface ForgeMessageDigest {
    update(msg: string, encoding?: string): ForgeMessageDigest;
    digest(): { toHex(): string };
  }
  interface ForgeCertificate {
    publicKey: ForgeKey;
    serialNumber: string;
    validity: { notBefore: Date; notAfter: Date };
    setSubject(attrs: ForgeCertAttr[]): void;
    setIssuer(attrs: ForgeCertAttr[]): void;
    setExtensions(exts: ForgeCertExtension[]): void;
    sign(key: ForgeKey, md?: ForgeMessageDigest): void;
  }
  interface ForgeStatic {
    pki: {
      rsa: { generateKeyPair(bits: number): ForgeKeyPair };
      createCertificate(): ForgeCertificate;
      certificateToPem(cert: ForgeCertificate): string;
      certificateFromPem(pem: string): ForgeCertificate;
      privateKeyToPem(key: ForgeKey): string;
      publicKeyToAsn1(key: ForgeKey): ForgeASN1;
    };
    asn1: { toDer(obj: ForgeASN1): { getBytes(): string } };
    md: { sha256: { create(): ForgeMessageDigest } };
    random: { getBytesSync(count: number): string };
  }
  const forge: ForgeStatic;
  export = forge;
}
