/**
 * E1/D1 server-core 鉴权测试（docs/specs/harmony/auth.md §7 A11/A12）。
 * 运行：pnpm --filter @zcode/server-cli test
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ServiceCollection } from "@zcode/services";
import { createCoreHttpServer } from "../src/server-core/http.js";

describe("server-core token 鉴权", () => {
  const services = new ServiceCollection();
  let handles: Array<() => Promise<void>> = [];

  before(() => {
    handles = [];
  });
  after(async () => {
    for (const close of handles.reverse()) {
      await close();
    }
  });

  function track(close: () => Promise<void>): void {
    handles.push(close);
  }

  it("A12 未提供 authToken 且非 loopback host → 启动 fail-closed", async () => {
    await assert.rejects(
      createCoreHttpServer(services, { host: "0.0.0.0", port: 0 }),
      /requires ZCODE_SERVER_AUTH_TOKEN/,
    );
  });

  it("A11 配置 authToken：无凭证 401，Bearer 200", async () => {
    const http = await createCoreHttpServer(services, {
      host: "127.0.0.1",
      port: 0,
      authToken: "core-admin-token",
    });
    track(http.close);
    const denied = await fetch(`http://127.0.0.1:${http.port}/api/server-info`);
    assert.equal(denied.status, 401);
    const allowed = await fetch(`http://127.0.0.1:${http.port}/api/server-info`, {
      headers: { authorization: "Bearer core-admin-token" },
    });
    assert.equal(allowed.status, 200);
    const info = (await allowed.json()) as {
      authRequired: boolean;
      capabilities: { authSchemes?: string[] };
    };
    assert.equal(info.authRequired, true);
    assert.ok(info.capabilities.authSchemes?.includes("bearer"));
  });

  it("未配置 authToken 时 loopback 保持开放（SSH 隧道既有行为不变）", async () => {
    const http = await createCoreHttpServer(services, { host: "127.0.0.1", port: 0 });
    track(http.close);
    const response = await fetch(`http://127.0.0.1:${http.port}/api/server-info`);
    assert.equal(response.status, 200);
    const info = (await response.json()) as { authRequired: boolean };
    assert.equal(info.authRequired, false);
  });
});
