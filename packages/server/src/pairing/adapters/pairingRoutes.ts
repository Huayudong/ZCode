/**
 * adapters 层：配对 REST 路由。
 * 鉴权分级由 tokenGuard 的 adminOnlyPaths/publicPaths 承担（单一守卫路径），
 * 这里只做 body 校验、错误→状态码映射与响应组装。
 * 行为规范：docs/specs/harmony/pairing.md §1/§4。
 */
import { Hono } from "hono";
import { formatZodError } from "@zcode/shared";
import { DeviceTokenLimitError } from "../../auth/contract.js";
import type { DeviceTokenRegistryPort } from "../../auth/contract.js";
import { pairingClaimBodySchema, pairingCodeBodySchema } from "../domain/pairingCodes.js";
import type { PairingServicePort } from "../app/ports.js";
import { PairingCodeInvalidError, PairingRateLimitedError } from "../app/ports.js";

export interface PairingServerIdentity {
  serverId: string;
  name?: string;
  /** 自签证书 SPKI SHA-256 hex（E3 接入后携带；当前缺省）。 */
  certFingerprint?: string;
}

export interface CreatePairingRoutesOptions {
  pairingService: PairingServicePort;
  deviceRegistry: DeviceTokenRegistryPort;
  serverIdentity: PairingServerIdentity;
}

/** tokenGuard 的配套路径分级；与路由路径保持同一事实源。 */
export const PAIRING_ADMIN_ONLY_PATHS = [
  "/api/pairing/code",
  "/api/pairing/devices",
] as const;

export const PAIRING_PUBLIC_PATHS = ["/api/pairing/claim"] as const;

function remoteIpOf(c: { env?: unknown }): string {
  // @hono/node-server 的 env 携带 Node incoming；拿不到时归并为单一桶。
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming;
  return incoming?.socket?.remoteAddress || "unknown";
}

export function createPairingRoutes(options: CreatePairingRoutesOptions): Hono {
  const routes = new Hono();
  const { pairingService, deviceRegistry, serverIdentity } = options;

  routes.post("/api/pairing/code", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      raw = {};
    }
    const parsed = pairingCodeBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: `Invalid request body: ${formatZodError(parsed.error)}` }, 400);
    }
    const issued = await pairingService.issueCode();
    return c.json({
      pairCode: issued.pairCode,
      pairCodeId: issued.pairCodeId,
      expiresAt: new Date(issued.expiresAtMs).toISOString(),
      ...(serverIdentity.certFingerprint ? { certFingerprint: serverIdentity.certFingerprint } : {}),
    });
  });

  routes.post("/api/pairing/claim", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid request body: expected JSON" }, 400);
    }
    const parsed = pairingClaimBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: `Invalid request body: ${formatZodError(parsed.error)}` }, 400);
    }
    try {
      const result = await pairingService.claim({
        pairCode: parsed.data.pairCode,
        deviceName: parsed.data.deviceName,
        ...(parsed.data.pushToken !== undefined ? { pushToken: parsed.data.pushToken } : {}),
        clientIp: remoteIpOf(c),
      });
      return c.json({
        accessToken: result.accessToken,
        serverId: serverIdentity.serverId,
        ...(serverIdentity.name ? { serverName: serverIdentity.name } : {}),
        ...(serverIdentity.certFingerprint
          ? { certFingerprint: serverIdentity.certFingerprint }
          : {}),
      });
    } catch (error) {
      if (error instanceof PairingCodeInvalidError) {
        // 统一 401 不带原因，防枚举（spec §3.2）。
        return c.json({ error: "Invalid pairing code" }, 401);
      }
      if (error instanceof PairingRateLimitedError) {
        c.header("Retry-After", String(Math.ceil(error.retryAfterMs / 1000)));
        return c.json({ error: "Too many pairing attempts" }, 429);
      }
      if (error instanceof DeviceTokenLimitError) {
        return c.json({ error: "Device limit reached" }, 409);
      }
      return c.json({ error: "Failed to issue device token" }, 500);
    }
  });

  routes.get("/api/pairing/devices", async (c) => {
    const devices = await deviceRegistry.list();
    return c.json({ devices });
  });

  routes.delete("/api/pairing/devices/:id", async (c) => {
    const id = c.req.param("id");
    const revoked = await deviceRegistry.revoke(id);
    if (!revoked) {
      return c.json({ error: "Device not found" }, 404);
    }
    return c.json({ ok: true });
  });

  return routes;
}
