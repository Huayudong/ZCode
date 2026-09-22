# server.tls CONTRACT

局域网 HTTPS 的 TLS 材料解析与自签证书。行为规范：`docs/specs/harmony/tls.md`。

## 不变量（类型无法表达的部分）

1. **指纹口径唯一**：`certFingerprint` ≡ SHA-256(SPKI DER) hex 小写，与 node `X509Certificate.publicKey` 的 SPKI 导出可互验；server-info、配对响应同源。
2. **fail-fast**：显式 PEM 配置读取/解析失败必须抛错阻止启动（错误含文件路径与原因），绝不静默降级 HTTP。
3. **自签幂等**：`<tlsDir>/server-{cert,key}.pem` 同时存在即复用；读取失败（如被外部损坏）时告警并重新生成。
4. 私钥文件 0600（POSIX 尽力），路径与内容不入日志。
5. `resolveTlsMaterial` 三种方式互斥按序判定：显式 PEM → 自签 → undefined（纯 HTTP）。

## 公开面

- `resolveTlsMaterial({ certPath?, keyPath?, selfSigned?, tlsDir?, logger? })`：解析 TLS 材料；无配置返回 `undefined`。
- `generateSelfSignedServerCertificate({ commonName, altNames })`：自签服务器证书（SAN=DNS+IP，serverAuth）。
- `computeSpkiSha256Fingerprint(certPem)`：SPKI SHA-256 hex。
- 类型：`TlsMaterial`、`CertificateMaterial`、`ResolveTlsMaterialOptions`、`TlsLogger`。
