/**
 * adapters 层：Hono 鉴权中间件（HTTP/WS 共用 upgrade 管道）。
 * 行为规范：docs/specs/harmony/auth.md §1/§5——凭证三路提取、管理员与设备两级比对、
 * query 命中种 cookie（Web SPA 兼容）、无凭证 401。
 */
import { timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import type { DeviceTokenRegistryPort } from "../app/ports.js";

const zcodeLiteTokenCookieName = "zcode_lite_token";

/** 鉴权保护面：/api/*、/ws、/ws/*；静态资源不走 token（由 http.ts 的 SPA fallback 逻辑复用同一判定）。 */
export function isTokenProtectedPath(pathname: string): boolean {
  return pathname === "/ws" || pathname.startsWith("/ws/") || pathname.startsWith("/api/");
}

function parseCookieHeader(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) {
    return cookies;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) {
      cookies.set(name, value);
    }
  }
  return cookies;
}

/** 常量时间 token 比较；长度不等时仍执行一次比较，保持时间轮廓稳定。 */
function timingSafeTokenEqual(presented: string, expected: string): boolean {
  const left = Buffer.from(presented, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

function extractBearerToken(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token ? token : undefined;
}

function seedLiteTokenCookie(c: Context, token: string): void {
  c.header(
    "Set-Cookie",
    `${zcodeLiteTokenCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`,
  );
}

async function hasValidCredential(
  c: Context,
  adminToken: string | undefined,
  registry: DeviceTokenRegistryPort | undefined,
): Promise<boolean> {
  const url = new URL(c.req.url);
  const bearerToken = extractBearerToken(c.req.header("authorization"));
  const queryToken = url.searchParams.get("token");
  const cookieToken = parseCookieHeader(c.req.header("cookie")).get(zcodeLiteTokenCookieName);
  const presented = bearerToken ?? queryToken ?? cookieToken;
  if (!presented) {
    return false;
  }
  if (adminToken !== undefined && timingSafeTokenEqual(presented, adminToken)) {
    // 保留既有行为：query 通道命中后种 HttpOnly cookie，后续请求免带 token。
    if (!bearerToken && queryToken !== null) {
      seedLiteTokenCookie(c, presented);
    }
    return true;
  }
  if (!registry) {
    return false;
  }
  // registry.verify 的契约是不 reject、失败返回 false（fail-closed）。
  return registry.verify(presented);
}

export interface TokenGuardOptions {
  /** 管理员 token（env/options 解析结果）。 */
  adminToken?: string;
  /** 设备 token 注册表；未提供时仅管理员 token 可鉴权。 */
  deviceTokenRegistry?: DeviceTokenRegistryPort;
}

/**
 * 创建鉴权中间件；未配置任何鉴权依据时返回 undefined，调用方按"无鉴权"语义跳过注册。
 */
export function createTokenGuard(options: TokenGuardOptions): MiddlewareHandler | undefined {
  const adminToken = options.adminToken?.trim() || undefined;
  const registry = options.deviceTokenRegistry;
  if (!adminToken && !registry) {
    return undefined;
  }
  return async (c, next) => {
    const pathname = new URL(c.req.url).pathname;
    if (!isTokenProtectedPath(pathname)) {
      await next();
      return;
    }
    if (await hasValidCredential(c, adminToken, registry)) {
      await next();
      return;
    }
    return c.json({ error: "Unauthorized" }, 401);
  };
}
