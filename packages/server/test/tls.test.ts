/**
 * E3 TLS 集成测试（docs/specs/harmony/tls.md §4 验收场景）。
 * 运行：pnpm --filter @zcode/server test
 */
import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Agent } from "undici";
import { createDeviceTokenRegistry } from "../src/auth/contract.js";
import { createPairingService } from "../src/pairing/adapters/createPairingService.js";
import {
  computeSpkiSha256Fingerprint,
  generateSelfSignedServerCertificate,
  resolveTlsMaterial,
} from "../src/tls/contract.js";
import { startTestHttpServer } from "./helpers/testServer.js";

/** 自签证书的 fetch（跳过自签校验）。 */
function insecureFetch(url: string, init?: Parameters<typeof fetch>[1]): Promise<Response> {
  return fetch(url, {
    ...init,
    dispatcher: new Agent({ connect: { rejectUnauthorized: false } }),
  } as Parameters<typeof fetch>[1]);
}

describe("server.tls 自签证书与 HTTPS", () => {
  const cleanups: Array<() => Promise<void>> = [];

  after(async () => {
    for (const cleanup of cleanups.reverse()) {
      await cleanup();
    }
  });

  it("T1 自签生成：PEM 可被 node X509Certificate 解析，SPKI 指纹口径一致", () => {
    const { certPem, keyPem } = generateSelfSignedServerCertificate({
      commonName: "test-host",
      altNames: ["test-host", "192.168.1.10"],
    });
    const x509 = new X509Certificate(certPem);
    assert.ok(x509.subject.includes("test-host"));
    assert.match(x509.subjectAltName ?? "", /192\.168\.1\.10/);
    const independent = createHash("sha256")
      .update(x509.publicKey.export({ type: "spki", format: "der" }))
      .digest("hex");
    assert.equal(computeSpkiSha256Fingerprint(certPem), independent);
    assert.match(keyPem, /PRIVATE KEY/);
  });

  it("T2 TLS 起 server：HTTPS server-info 200 且指纹一致", async () => {
    const tls = await resolveTlsMaterial({ selfSigned: true, tlsDir: join(await mkdtemp(join(tmpdir(), "zcode-tls-")), "tls") });
    assert.ok(tls, "selfSigned 应产出材料");
    const server = await startTestHttpServer({ tls, authToken: "t2-admin" });
    cleanups.push(() => server.close());
    assert.equal(server.baseUrl.startsWith("https://"), true);
    const denied = await insecureFetch(`${server.baseUrl}/api/server-info`);
    assert.equal(denied.status, 401);
    const info = await insecureFetch(`${server.baseUrl}/api/server-info`, {
      headers: { authorization: "Bearer t2-admin" },
    });
    assert.equal(info.status, 200);
    const body = (await info.json()) as { capabilities: { certFingerprint?: string } };
    assert.equal(body.capabilities.certFingerprint, tls.certFingerprint);
  });

  it("T3 配对 claim 响应携带同一 certFingerprint", async () => {
    const tls = await resolveTlsMaterial({ selfSigned: true, tlsDir: join(await mkdtemp(join(tmpdir(), "zcode-tls-")), "tls") });
    assert.ok(tls);
    const deviceRegistry = createDeviceTokenRegistry({
      filePath: join(await mkdtemp(join(tmpdir(), "zcode-tls-")), "tokens.json"),
    });
    const pairingService = createPairingService({ deviceRegistry });
    const server = await startTestHttpServer({
      tls,
      authToken: "t3-admin",
      deviceTokenRegistry: deviceRegistry,
      pairingService: pairingService,
    });
    cleanups.push(() => server.close());
    const code = await insecureFetch(`${server.baseUrl}/api/pairing/code`, {
      method: "POST",
      headers: { authorization: "Bearer t3-admin" },
      body: "{}",
    });
    assert.equal(code.status, 200);
    const { pairCode, certFingerprint } = (await code.json()) as {
      pairCode: string;
      certFingerprint?: string;
    };
    assert.equal(certFingerprint, tls.certFingerprint);
    const claim = await insecureFetch(`${server.baseUrl}/api/pairing/claim`, {
      method: "POST",
      body: JSON.stringify({ pairCode, deviceName: "tls-phone" }),
    });
    assert.equal(claim.status, 200);
    const claimed = (await claim.json()) as { accessToken: string; certFingerprint?: string };
    assert.equal(claimed.certFingerprint, tls.certFingerprint);
  });

  it("T4 显式 PEM 缺失/不齐 → fail-fast 抛错", async () => {
    const missing = resolveTlsMaterial({
      certPath: join(tmpdir(), "no-such-cert.pem"),
      keyPath: join(tmpdir(), "no-such-key.pem"),
    });
    await assert.rejects(missing, /TLS PEM 文件读取失败/);
    const incomplete = resolveTlsMaterial({ certPath: "only-cert.pem" });
    await assert.rejects(incomplete, /必须同时提供/);
  });

  it("T5 未配 TLS → 纯 HTTP 行为不变（回归）", async () => {
    const server = await startTestHttpServer({});
    cleanups.push(() => server.close());
    assert.equal(server.baseUrl.startsWith("http://"), true);
    const response = await fetch(`${server.baseUrl}/api/server-info`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { capabilities: { certFingerprint?: string } };
    assert.equal(body.capabilities.certFingerprint, undefined);
  });

  it("自签幂等：同目录二次解析复用同一证书（指纹不变）", async () => {
    const tlsDir = join(await mkdtemp(join(tmpdir(), "zcode-tls-idem-")), "tls");
    const first = await resolveTlsMaterial({ selfSigned: true, tlsDir });
    const second = await resolveTlsMaterial({ selfSigned: true, tlsDir });
    assert.ok(first && second);
    assert.equal(first.certFingerprint, second.certFingerprint);
  });
});
