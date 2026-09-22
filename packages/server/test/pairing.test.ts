/**
 * E2 配对服务集成测试（docs/specs/harmony/pairing.md §7 验收场景）。
 * 运行：pnpm --filter @zcode/server test
 */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createDeviceTokenRegistry, type DeviceTokenRegistryPort } from "../src/auth/contract.js";
import { createPairingService } from "../src/pairing/adapters/createPairingService.js";
import type { PairingServicePort } from "../src/pairing/contract.js";
import { startTestHttpServer, type TestHttpServerHandle } from "./helpers/testServer.js";

/** 可控时钟：用于 TTL 过期场景。 */
function createTestClock() {
  let nowMs = 1_700_000_000_000;
  return {
    nowMs: () => nowMs,
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

/** 组装一套"管理员 + 设备表 + 配对服务"的测试环境并起 HTTP server。 */
async function startPairingServer(overrides?: {
  clock?: ReturnType<typeof createTestClock>;
  deviceRegistry?: DeviceTokenRegistryPort;
}): Promise<{
  server: TestHttpServerHandle;
  adminToken: string;
  pairingService: PairingServicePort;
  deviceRegistry: DeviceTokenRegistryPort;
}> {
  const adminToken = "pairing-admin-token";
  const deviceRegistry =
    overrides?.deviceRegistry ??
    createDeviceTokenRegistry({
      filePath: join(await mkdtemp(join(tmpdir(), "zcode-pairing-test-")), "access-tokens.json"),
    });
  const clock = overrides?.clock ?? createTestClock();
  const pairingService = createPairingService({ deviceRegistry, clock });
  const server = await startTestHttpServer({
    authToken: adminToken,
    deviceTokenRegistry: deviceRegistry,
    pairingService: pairingService,
  });
  return { server, adminToken, pairingService, deviceRegistry };
}

async function issuePairCode(
  server: TestHttpServerHandle,
  adminToken: string,
): Promise<{ pairCode: string; expiresAt: string }> {
  const response = await fetch(`${server.baseUrl}/api/pairing/code`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}` },
    body: "{}",
  });
  assert.equal(response.status, 200);
  return (await response.json()) as { pairCode: string; expiresAt: string };
}

describe("server.pairing 配对服务", () => {
  const cleanups: Array<() => Promise<void>> = [];

  after(async () => {
    for (const cleanup of cleanups.reverse()) {
      await cleanup();
    }
  });

  it("P1 出码 → claim → 设备 accessToken 可用 Bearer 访问 server-info", async () => {
    const { server, adminToken } = await startPairingServer();
    cleanups.push(() => server.close());
    const { pairCode } = await issuePairCode(server, adminToken);

    const claim = await fetch(`${server.baseUrl}/api/pairing/claim`, {
      method: "POST",
      body: JSON.stringify({ pairCode, deviceName: "测试手机" }),
    });
    assert.equal(claim.status, 200);
    const { accessToken, serverId } = (await claim.json()) as {
      accessToken: string;
      serverId: string;
    };
    assert.ok(accessToken.startsWith("zcd_"));
    assert.ok(serverId.length > 0);

    const info = await fetch(`${server.baseUrl}/api/server-info`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(info.status, 200);
  });

  it("P2 同一 pairCode 二次 claim → 401（一次性）", async () => {
    const { server, adminToken } = await startPairingServer();
    cleanups.push(() => server.close());
    const { pairCode } = await issuePairCode(server, adminToken);
    const body = JSON.stringify({ pairCode, deviceName: "phone" });
    const first = await fetch(`${server.baseUrl}/api/pairing/claim`, { method: "POST", body });
    assert.equal(first.status, 200);
    const replay = await fetch(`${server.baseUrl}/api/pairing/claim`, { method: "POST", body });
    assert.equal(replay.status, 401);
  });

  it("P3 TTL 过期后 claim → 401（可控时钟）", async () => {
    const clock = createTestClock();
    const { server, adminToken } = await startPairingServer({ clock });
    cleanups.push(() => server.close());
    const { pairCode } = await issuePairCode(server, adminToken);
    clock.advance(5 * 60_000 + 1);
    const claim = await fetch(`${server.baseUrl}/api/pairing/claim`, {
      method: "POST",
      body: JSON.stringify({ pairCode, deviceName: "phone" }),
    });
    assert.equal(claim.status, 401);
  });

  it("P4 并发 10 个 claim 同一 pairCode → 恰好 1 个 200", async () => {
    const { server, adminToken } = await startPairingServer();
    cleanups.push(() => server.close());
    const { pairCode } = await issuePairCode(server, adminToken);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        fetch(`${server.baseUrl}/api/pairing/claim`, {
          method: "POST",
          body: JSON.stringify({ pairCode, deviceName: "race" }),
        }),
      ),
    );
    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Response> => r.status === "fulfilled",
    );
    assert.equal(fulfilled.length, 10);
    const ok = fulfilled.filter((r) => r.value.status === 200);
    assert.equal(ok.length, 1, "并发 claim 只有一个成功");
  });

  it("P5 设备 token 访问管理端点 → 403（合法设备、权限不足）", async () => {
    const { server, adminToken, deviceRegistry } = await startPairingServer();
    cleanups.push(() => server.close());
    const { token } = await deviceRegistry.issue({ deviceName: "p5-phone" });
    const denied = await fetch(`${server.baseUrl}/api/pairing/code`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "{}",
    });
    assert.equal(denied.status, 403);
    // 出码仍归管理员。
    const allowed = await fetch(`${server.baseUrl}/api/pairing/code`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}` },
      body: "{}",
    });
    assert.equal(allowed.status, 200);
  });

  it("claim 频控：同 IP 窗口内 10 次后 → 429 + Retry-After", async () => {
    const { server, adminToken } = await startPairingServer();
    cleanups.push(() => server.close());
    // 10 次无效 claim（全部 401）计入窗口。
    for (let i = 0; i < 10; i += 1) {
      const response = await fetch(`${server.baseUrl}/api/pairing/claim`, {
        method: "POST",
        body: JSON.stringify({ pairCode: "zpc_wrong", deviceName: "phone" }),
      });
      assert.equal(response.status, 401);
    }
    const limited = await fetch(`${server.baseUrl}/api/pairing/claim`, {
      method: "POST",
      body: JSON.stringify({ pairCode: "zpc_wrong", deviceName: "phone" }),
    });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
    // 频控不影响管理员出码通道。
    const code = await issuePairCode(server, adminToken);
    assert.ok(code.pairCode.startsWith("zpc_"));
  });

  it("claim body 非法 → 400；管理端点无凭证 → 401", async () => {
    const { server, adminToken } = await startPairingServer();
    cleanups.push(() => server.close());
    const noName = await fetch(`${server.baseUrl}/api/pairing/claim`, {
      method: "POST",
      body: JSON.stringify({ pairCode: "zpc_x" }),
    });
    assert.equal(noName.status, 400);
    const noCreds = await fetch(`${server.baseUrl}/api/pairing/devices`);
    assert.equal(noCreds.status, 401);
    const devices = await fetch(`${server.baseUrl}/api/pairing/devices`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(devices.status, 200);
  });

  it("DELETE devices/:id：吊销成功 200、未知 id 404", async () => {
    const { server, adminToken, deviceRegistry } = await startPairingServer();
    cleanups.push(() => server.close());
    const { record } = await deviceRegistry.issue({ deviceName: "del-phone" });
    const ok = await fetch(`${server.baseUrl}/api/pairing/devices/${record.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(ok.status, 200);
    const missing = await fetch(`${server.baseUrl}/api/pairing/devices/no-such-id`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(missing.status, 404);
  });

  it("claim 时设备数达上限 → 409，且 pairCode 已消费不回滚（重放 401）", async () => {
    const filePath = join(await mkdtemp(join(tmpdir(), "zcode-pairing-limit-")), "tokens.json");
    const registry = createDeviceTokenRegistry({ filePath });
    const { server, adminToken } = await startPairingServer({ deviceRegistry: registry });
    cleanups.push(() => server.close());
    // 填满上限（64）：直接 issue 64 个设备。
    for (let i = 0; i < 64; i += 1) {
      await registry.issue({ deviceName: `bulk-${i}` });
    }
    const { pairCode } = await issuePairCode(server, adminToken);
    const claim = await fetch(`${server.baseUrl}/api/pairing/claim`, {
      method: "POST",
      body: JSON.stringify({ pairCode, deviceName: "overflow" }),
    });
    assert.equal(claim.status, 409);
    // pairCode 已消费：修复上限后重放仍 401（不回滚）。
    const replay = await fetch(`${server.baseUrl}/api/pairing/claim`, {
      method: "POST",
      body: JSON.stringify({ pairCode, deviceName: "overflow" }),
    });
    assert.equal(replay.status, 401);
  });
});
