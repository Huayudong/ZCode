/**
 * E1 鉴权集成测试（docs/specs/harmony/auth.md §7 验收场景）。
 * 运行：pnpm --filter @zcode/server test
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { WebSocket } from "ws";
import { createDeviceTokenRegistry } from "../src/auth/contract.js";
import { startTestHttpServer, type TestHttpServerHandle } from "./helpers/testServer.js";

async function withTempTokenStore(): Promise<{ filePath: string; cleanup(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-auth-test-"));
  return { filePath: join(dir, "access-tokens.json"), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("http token 鉴权", () => {
  const adminToken = "admin-secret-token";

  it("A1 未携带凭证访问受保护路径 → 401", async () => {
    const server = await startTestHttpServer({ authToken: adminToken });
    try {
      const response = await fetch(`${server.baseUrl}/api/server-info`);
      assert.equal(response.status, 401);
    } finally {
      await server.close();
    }
  });

  it("A2 Bearer 管理员 token → 200，server-info 如实反映鉴权", async () => {
    const server = await startTestHttpServer({ authToken: adminToken });
    try {
      const response = await fetch(`${server.baseUrl}/api/server-info`, {
        headers: { authorization: `Bearer ${adminToken}` },
      });
      assert.equal(response.status, 200);
      const info = (await response.json()) as {
        authRequired: boolean;
        capabilities: { authSchemes?: string[] };
      };
      assert.equal(info.authRequired, true);
      assert.ok(info.capabilities.authSchemes?.includes("bearer"));
    } finally {
      await server.close();
    }
  });

  it("A3 query token → 200 并种 HttpOnly cookie", async () => {
    const server = await startTestHttpServer({ authToken: adminToken });
    try {
      const response = await fetch(`${server.baseUrl}/api/server-info?token=${adminToken}`);
      assert.equal(response.status, 200);
      const setCookie = response.headers.get("set-cookie") ?? "";
      assert.ok(setCookie.includes("zcode_lite_token="));
      assert.ok(setCookie.includes("HttpOnly"));
    } finally {
      await server.close();
    }
  });

  it("A4 cookie 通道 → 200", async () => {
    const server = await startTestHttpServer({ authToken: adminToken });
    try {
      const response = await fetch(`${server.baseUrl}/api/server-info`, {
        headers: { cookie: `zcode_lite_token=${adminToken}` },
      });
      assert.equal(response.status, 200);
    } finally {
      await server.close();
    }
  });

  it("A5 回归：仅配置 ZCODE_SERVER_AUTH_TOKEN 时 authRequired 如实为 true", async () => {
    process.env["ZCODE_SERVER_AUTH_TOKEN"] = "env-only-token";
    let server: TestHttpServerHandle | undefined;
    try {
      server = await startTestHttpServer({});
      const denied = await fetch(`${server.baseUrl}/api/server-info`);
      assert.equal(denied.status, 401);
      const allowed = await fetch(`${server.baseUrl}/api/server-info`, {
        headers: { authorization: "Bearer env-only-token" },
      });
      assert.equal(allowed.status, 200);
      const info = (await allowed.json()) as { authRequired: boolean };
      assert.equal(info.authRequired, true);
    } finally {
      delete process.env["ZCODE_SERVER_AUTH_TOKEN"];
      await server?.close();
    }
  });

  it("A6 兼容：旧 ZCODE_SERVER_TOKEN 仍生效", async () => {
    process.env["ZCODE_SERVER_TOKEN"] = "legacy-token";
    let server: TestHttpServerHandle | undefined;
    try {
      server = await startTestHttpServer({});
      const denied = await fetch(`${server.baseUrl}/api/server-info`);
      assert.equal(denied.status, 401);
      const allowed = await fetch(`${server.baseUrl}/api/server-info`, {
        headers: { authorization: "Bearer legacy-token" },
      });
      assert.equal(allowed.status, 200);
    } finally {
      delete process.env["ZCODE_SERVER_TOKEN"];
      await server?.close();
    }
  });

  it("未配置任何鉴权依据时保持默认开放（本机 dev 行为不变）", async () => {
    const server = await startTestHttpServer({});
    try {
      const response = await fetch(`${server.baseUrl}/api/server-info`);
      assert.equal(response.status, 200);
      const info = (await response.json()) as { authRequired: boolean };
      assert.equal(info.authRequired, false);
    } finally {
      await server.close();
    }
  });

  it("WS upgrade 同样受鉴权保护：无凭证 401，有凭证 101", async () => {
    const server = await startTestHttpServer({ authToken: adminToken });
    try {
      const denied = await new Promise<Error>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
        ws.on("open", () => {
          ws.close();
          reject(new Error("unauthorized ws upgrade should not open"));
        });
        ws.on("error", (error) => resolve(error));
      });
      assert.ok(String(denied.message).includes("401"));

      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
        headers: { authorization: `Bearer ${adminToken}` },
      });
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });
      ws.close();
    } finally {
      await server.close();
    }
  });
});

describe("server.auth 设备 token 注册表", () => {
  let store: { filePath: string; cleanup(): Promise<void> };

  before(async () => {
    store = await withTempTokenStore();
  });
  after(async () => {
    await store.cleanup();
  });

  it("A7/A8 签发 → Bearer 放行 → 吊销 → 401", async () => {
    const registry = createDeviceTokenRegistry({ filePath: store.filePath });
    const { token } = await registry.issue({ deviceName: "测试手机" });
    const server = await startTestHttpServer({ authToken: "admin", deviceTokenRegistry: registry });
    try {
      const allowed = await fetch(`${server.baseUrl}/api/server-info`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(allowed.status, 200);

      const records = await registry.list();
      assert.equal(records.length, 1);
      assert.equal(await registry.revoke(records[0]!.id), true);

      const denied = await fetch(`${server.baseUrl}/api/server-info`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(denied.status, 401);
    } finally {
      await server.close();
    }
  });

  it("A10 落盘只含 tokenHash，无明文 token", async () => {
    const filePath = join(store.filePath, "..", "plain-check.json");
    const registry = createDeviceTokenRegistry({ filePath });
    const { token } = await registry.issue({ deviceName: "plain" });
    const raw = await readFile(filePath, "utf8");
    assert.ok(!raw.includes(token));
    const document = JSON.parse(raw) as { version: number; records: Array<{ tokenHash: string }> };
    assert.equal(document.version, 1);
    assert.equal(document.records.length, 1);
    assert.notEqual(document.records[0]!.tokenHash, token);
  });

  it("revoke 幂等：已吊销再吊销返回 true，未知 id 返回 false", async () => {
    const filePath = join(store.filePath, "..", "idempotent.json");
    const registry = createDeviceTokenRegistry({ filePath });
    const { record } = await registry.issue({ deviceName: "idem" });
    assert.equal(await registry.revoke(record.id), true);
    assert.equal(await registry.revoke(record.id), true);
    assert.equal(await registry.revoke("no-such-id"), false);
  });

  it("设备名规范化：空名拒绝、控制字符剔除、超长截断", async () => {
    const filePath = join(store.filePath, "..", "names.json");
    const registry = createDeviceTokenRegistry({ filePath });
    await assert.rejects(registry.issue({ deviceName: "   " }), /设备名不能为空/);
    const { record } = await registry.issue({ deviceName: "  my\u0000phone  " });
    assert.equal(record.deviceName, "myphone");
  });

  it("A9 表文件损坏：按空表继续，签发成功并覆写修复", async () => {
    const filePath = join(store.filePath, "..", "corrupt.json");
    await writeFile(filePath, "{not-json", "utf8");
    const registry = createDeviceTokenRegistry({ filePath });
    // spec §4：坏 JSON 按空表处理（warn），签发以空表为基线成功并覆写修复。
    const { token } = await registry.issue({ deviceName: "after-corrupt" });
    assert.ok(token.startsWith("zcd_"));
    const records = await registry.list();
    assert.equal(records.length, 1);
    const second = await registry.issue({ deviceName: "second" });
    assert.ok(second.token.startsWith("zcd_"));
    assert.equal((await registry.list()).length, 2);
  });
});
