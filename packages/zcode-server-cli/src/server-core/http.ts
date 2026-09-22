import { randomUUID, timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono, type MiddlewareHandler } from "hono";
import type { WebSocket } from "ws";
import type { WebSocketServer } from "ws";
import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelServer,
  LoggingChannelServer,
  type ISocket,
} from "@zcode/rpc";
import {
  createZCodeAgentConnectionScope,
  IZCodeAgentService,
  ServiceCollection,
} from "@zcode/services";
import { createServiceLogger } from "@zcode/services/node";
import {
  SERVER_REMOTE_PROTOCOL_VERSION,
  ZCODE_RPC_HOST_CAPABILITY_HEADER,
  ZCODE_VERSION,
  type ServerRemoteInfo,
} from "@zcode/shared";
import { createHostCapabilityStore, type HostCapabilityStore } from "./hostCapability.js";

interface CoreHttpServer {
  host: string;
  port: number;
  close: () => Promise<void>;
}

const WEBSOCKET_DRAIN_TIMEOUT_MS = 250;
const log = createServiceLogger("server-core");

async function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) {
    // HTTP server.close() 不会收敛已经 upgrade 的 WebSocket，活跃 desktop
    // continuous 连接会让 Core 的 shutdown ack 永远发不出去。先发 close frame 给正常
    // 客户端一个短暂排空窗口，再 terminate 兜底，保证 Supervisor 能在预算内释放资源。
    client.close(1001, "Server shutting down");
  }
  const deadline = Date.now() + WEBSOCKET_DRAIN_TIMEOUT_MS;
  while (wss.clients.size > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolve, reject) => {
    wss.close((error?: Error) => (error ? reject(error) : resolve()));
  });
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

const coreLiteTokenCookieName = "zcode_lite_token";

function parseCoreCookieHeader(header: string | undefined): Map<string, string> {
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

function coreTimingSafeTokenEqual(presented: string, expected: string): boolean {
  const left = Buffer.from(presented, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length) {
    // 长度不等时仍执行一次比较，保持时间轮廓稳定（防时序侧信道）。
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * Core 专用鉴权中间件：与 packages/server tokenGuard 相同的三路凭证提取语义
 * （Bearer → query → cookie，query 命中种 HttpOnly cookie），仅比对管理员 token。
 * 返回 undefined 表示未配置鉴权（此时非 loopback 已在上方 fail-closed）。
 */
function createCoreTokenGuard(adminToken: string | undefined): MiddlewareHandler | undefined {
  if (!adminToken) {
    return undefined;
  }
  return async (context, next) => {
    const pathname = new URL(context.req.url).pathname;
    const isProtected =
      pathname === "/ws" || pathname.startsWith("/ws/") || pathname.startsWith("/api/");
    if (!isProtected) {
      await next();
      return;
    }
    const url = new URL(context.req.url);
    const bearerMatch = /^Bearer\s+(.+)$/i.exec(context.req.header("authorization")?.trim() ?? "");
    const bearerToken = bearerMatch?.[1]?.trim() || undefined;
    const queryToken = url.searchParams.get("token");
    const cookieToken = parseCoreCookieHeader(context.req.header("cookie")).get(
      coreLiteTokenCookieName,
    );
    const presented = bearerToken ?? queryToken ?? cookieToken;
    if (presented && coreTimingSafeTokenEqual(presented, adminToken)) {
      if (!bearerToken && queryToken !== null) {
        context.header(
          "Set-Cookie",
          `${coreLiteTokenCookieName}=${encodeURIComponent(presented)}; Path=/; HttpOnly; SameSite=Lax`,
        );
      }
      await next();
      return;
    }
    return context.json({ error: "Unauthorized" }, 401);
  };
}

function wrapWebSocket(ws: WebSocket): ISocket {
  const data = new Emitter<VSBuffer>();
  const close = new Emitter<void>();
  ws.on("message", (raw) =>
    data.fire(VSBuffer.wrap(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer))),
  );
  ws.on("close", () => close.fire());
  ws.on("error", () => close.fire());
  return {
    onData: data.event,
    onClose: close.event,
    onEnd: close.event,
    write(buffer) {
      if (ws.readyState === ws.OPEN) ws.send(buffer.buffer);
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.close();
    },
  };
}

function exposeWebSocket(
  ws: WebSocket,
  services: ServiceCollection,
  clientMode: "desktop-continuous" | "web-remote-replayable",
): void {
  const socket = wrapWebSocket(ws);
  const protocol = new SocketProtocol(socket);
  const rawServer = new ChannelServer(protocol, "server");
  const server = new LoggingChannelServer(rawServer, (...args) => log.debug(undefined, ...args));
  const agentService = services.getOptional(IZCodeAgentService);
  const scope = agentService
    ? createZCodeAgentConnectionScope(agentService, {
        connectionId: `server-core-ws-${randomUUID()}`,
        clientMode,
        role: clientMode === "desktop-continuous" ? "trusted-host-relay" : "terminal-client",
      })
    : undefined;
  services.exposeOnChannelServer(
    server,
    scope ? new Map([[IZCodeAgentService.channelName, scope.service]]) : new Map(),
  );
  socket.onClose(() => {
    void scope?.dispose();
    rawServer.dispose();
  });
}

export async function createCoreHttpServer(
  services: ServiceCollection,
  options: {
    host?: string;
    port?: number;
    serverId?: string;
    hostCapabilityStore?: HostCapabilityStore;
    /** 管理员 token（E1）：提供时对受保护路径启用同语义鉴权，并允许非 loopback 监听。 */
    authToken?: string;
  } = {},
): Promise<CoreHttpServer> {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket, wss } = createNodeWebSocket({ app });
  const host = options.host ?? "127.0.0.1";
  const authToken = options.authToken?.trim() || undefined;
  // 修复依据（E1/D1，docs/specs/harmony/auth.md）：Core 原先对非 loopback 一律 fail-closed
  // （"Core 尚未接入 token middleware"）。接入管理员 token 中间件后改为条件放行：
  // 配置了 token 才允许对外监听，未配置时维持 fail-closed，消除与 packages/server 的安全语义分叉。
  if (!isLoopbackHost(host) && !authToken) {
    throw new Error(
      `Non-loopback host ${host} requires ZCODE_SERVER_AUTH_TOKEN before the server can listen`,
    );
  }
  const info: ServerRemoteInfo = {
    serverId: options.serverId ?? hostname() ?? "zcode-server",
    version: ZCODE_VERSION,
    protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
    authRequired: Boolean(authToken),
    workspaces: [],
    capabilities: {
      desktopContinuous: true,
      websocketRpc: true,
      processResourceTelemetry: true,
      ...(authToken ? { authSchemes: ["bearer", "cookie", "query"] } : {}),
    },
  };
  // 裸 Set 无法落实 expiresAt，未消费的 capability 会一直有效并持续累积。
  // 使用与 packages/server 兼容的 TTL 一次性 store，使有效期和消费语义与返回信息一致。
  const capabilities = options.hostCapabilityStore ?? createHostCapabilityStore();
  // Core 的鉴权是 packages/server tokenGuard 的"仅管理员 token"子集：SSH 隧道形态的
  // 访问者是人而非多设备，不接 server.auth 设备表；刻意不跨包复用，避免把 server 的
  // 部署工具链依赖（ssh2/node-pty 等）拖进无头发行包（spec §2 边界说明）。
  const tokenGuard = createCoreTokenGuard(authToken);
  if (tokenGuard) {
    app.use("*", tokenGuard);
  }
  app.get("/api/server-info", (context) => context.json(info));
  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(_event, socket) {
        exposeWebSocket(socket.raw as WebSocket, services, "web-remote-replayable");
      },
    })),
  );
  app.use("/ws/host", async (context, next) => {
    const capability = context.req.header(ZCODE_RPC_HOST_CAPABILITY_HEADER);
    if (!capabilities.consume(capability)) {
      return context.json({ error: "Invalid or expired host capability" }, 401);
    }
    await next();
  });
  app.get(
    "/ws/host",
    upgradeWebSocket(() => ({
      onOpen(_event, socket) {
        exposeWebSocket(socket.raw as WebSocket, services, "desktop-continuous");
      },
    })),
  );
  app.post("/api/rpc-host-capability", (context) => context.json(capabilities.issue()));
  let resolveListening: (value: { port: number }) => void = () => undefined;
  const listening = new Promise<{ port: number }>((resolve) => {
    resolveListening = resolve;
  });
  const server = serve({ fetch: app.fetch, hostname: host, port: options.port ?? 0 }, () => {
    const address = server.address();
    resolveListening({
      port: typeof address === "object" && address ? address.port : (options.port ?? 0),
    });
  });
  injectWebSocket(server);
  const { port } = await listening;
  return {
    host,
    port,
    close: async () => {
      await closeWebSocketServer(wss);
      await new Promise<void>((resolve, reject) =>
        server.close((error?: Error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
