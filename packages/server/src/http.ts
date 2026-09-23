/* eslint-disable max-lines -- HTTP、WebSocket 与静态资源路由集中注册，保持同一鉴权顺序。 */
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
import { hostname } from "node:os";
import https from "node:https";
import { Hono } from "hono";
import { getRequestListener, serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WebSocket } from "ws";
import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelServer,
  LoggingChannelServer,
  type ISocket,
} from "@zcode/rpc";
import {
  ServiceCollection,
  IZCodeAgentService,
  createZCodeAgentConnectionScope,
  IFileService,
  IGitService,
  ISystemService,
  ITerminalService,
  IProviderProvisioningTargetService,
} from "@zcode/services";
import {
  formatLogPrefix,
  formatZodError,
  remoteTargetSchema,
  SERVER_REMOTE_PROTOCOL_VERSION,
  ZCODE_RPC_HOST_CAPABILITY_HEADER,
  ZCODE_VERSION,
  type ServerRemoteInfo,
  type ServerRemoteWorkspaceInfo,
} from "@zcode/shared";
import { connectRemote, createRemoteBackend, type RemoteConnection } from "./remote/index.js";
import { createHostCapabilityStore } from "./hostCapability.js";
import {
  createTokenGuard,
  isTokenProtectedPath,
  type DeviceTokenRegistryPort,
} from "./auth/contract.js";
import {
  PAIRING_ADMIN_ONLY_PATHS,
  PAIRING_PUBLIC_PATHS,
  createPairingRoutes,
  type PairingServicePort,
} from "./pairing/contract.js";
import type { TlsMaterial } from "./tls/contract.js";

function wrapWebSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    onData.fire(VSBuffer.wrap(new Uint8Array(buf)));
  });
  ws.on("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.on("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === ws.OPEN) {
        ws.send(buffer.buffer);
      }
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

const log = (...args: unknown[]) =>
  console.log(formatLogPrefix("zcode-server:http", process.pid), ...args);

function setupChannelServer(
  ws: WebSocket,
  services: ServiceCollection,
  clientMode: "desktop-continuous" | "web-remote-replayable",
) {
  const socket = wrapWebSocket(ws);
  const protocol = new SocketProtocol(socket);
  const rawServer = new ChannelServer(protocol, "server");
  // 用日志中间件包装，统一记录所有 RPC 调用
  const server = new LoggingChannelServer(rawServer, log);
  const agentService = services.getOptional(IZCodeAgentService);
  const connectionScope = agentService
    ? createZCodeAgentConnectionScope(agentService, {
        connectionId: `server-ws-${randomUUID()}`,
        clientMode,
        role: clientMode === "desktop-continuous" ? "trusted-host-relay" : "terminal-client",
      })
    : undefined;
  const overrides = new Map<string, unknown>();
  if (connectionScope) {
    overrides.set(IZCodeAgentService.channelName, connectionScope.service);
  }
  // Provisioning 携带跨 Environment 凭据，只允许 Desktop trusted host 使用；普通 Web
  // remote/replayable 客户端即使知道频道名，也不能获得 target 写入接口。
  if (
    clientMode !== "desktop-continuous" &&
    services.getOptional(IProviderProvisioningTargetService)
  ) {
    overrides.set(IProviderProvisioningTargetService.channelName, {
      apply: async () => {
        throw new Error("Provider Provisioning 仅支持受信 Desktop Host");
      },
    });
  }
  services.exposeOnChannelServer(server, overrides);
  socket.onClose(() => {
    void connectionScope?.dispose();
    rawServer.dispose();
  });
}

/** 存储 web 模式下的远程连接，key 为随机 ID */
const remoteConnections = new Map<string, RemoteConnection>();

function generateId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

interface HttpServerOptions {
  serverId?: string;
  name?: string;
  host?: string;
  authRequired?: boolean;
  authToken?: string;
  /** 设备 token 注册表（server.auth 模块）；仅与鉴权启用场景搭配（entry-http 在有管理员 token 时接线）。 */
  deviceTokenRegistry?: DeviceTokenRegistryPort;
  /** 配对服务（server.pairing 模块）；与 deviceTokenRegistry 同时接线才生效。 */
  pairingService?: PairingServicePort;
  /** TLS 材料（server.tls 模块解析）；提供时以 HTTPS/WSS 监听并下发证书指纹。 */
  tls?: TlsMaterial;
  spaFallback?: boolean;
  staticRoot?: string;
  workspaces?: ServerRemoteWorkspaceInfo[];
}

function readTrimmedEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function resolveServerId(options: HttpServerOptions): string {
  return (
    options.serverId?.trim() || readTrimmedEnv("ZCODE_SERVER_ID") || hostname() || "zcode-server"
  );
}

// 旧环境变量只告警一次，避免每个请求刷日志。
let legacyTokenEnvWarned = false;

/**
 * 解析生效的管理员 token：显式 options 优先，其次 ZCODE_SERVER_AUTH_TOKEN，
 * 最后兼容已弃用的 ZCODE_SERVER_TOKEN（告警一次）。
 * 修复依据：旧实现 server-info 读 ZCODE_SERVER_TOKEN 判定 authRequired，而中间件用
 * entry-http 传入的 ZCODE_SERVER_AUTH_TOKEN，变量名不一致导致 authRequired 谎报；
 * 现由本函数作为唯一解析来源，同时供中间件与 server-info 使用（docs/specs/harmony/auth.md §1）。
 */
function resolveEffectiveAuthToken(options: HttpServerOptions): string | undefined {
  if (options.authToken?.trim()) {
    return options.authToken.trim();
  }
  const primary = readTrimmedEnv("ZCODE_SERVER_AUTH_TOKEN");
  if (primary) {
    return primary;
  }
  const legacy = readTrimmedEnv("ZCODE_SERVER_TOKEN");
  if (legacy && !legacyTokenEnvWarned) {
    legacyTokenEnvWarned = true;
    log("环境变量 ZCODE_SERVER_TOKEN 已弃用，请改用 ZCODE_SERVER_AUTH_TOKEN");
  }
  return legacy;
}

function resolveServerWorkspaces(options: HttpServerOptions): ServerRemoteWorkspaceInfo[] {
  if (options.workspaces) {
    return options.workspaces;
  }
  const workspacePath = readTrimmedEnv("ZCODE_SERVER_WORKSPACE") || process.cwd();
  return [
    {
      path: workspacePath,
      label: basename(workspacePath) || workspacePath,
    },
  ];
}

function createServerInfo(options: HttpServerOptions, authEnabled: boolean): ServerRemoteInfo {
  return {
    serverId: resolveServerId(options),
    ...(options.name?.trim() || readTrimmedEnv("ZCODE_SERVER_NAME")
      ? { name: options.name?.trim() || readTrimmedEnv("ZCODE_SERVER_NAME") }
      : {}),
    version: ZCODE_VERSION,
    protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
    authRequired: options.authRequired ?? authEnabled,
    workspaces: resolveServerWorkspaces(options),
    capabilities: {
      desktopContinuous: true,
      websocketRpc: true,
      processResourceTelemetry: true,
      // additive 能力位：旧客户端的 zod 非 strict 解析会忽略未知键，不受影响；
      // 新客户端对缺失该字段的老 server 需按仅 query/cookie 兜底。
      ...(authEnabled ? { authSchemes: ["bearer", "cookie", "query"] } : {}),
      // 证书固定指纹：仅 TLS 启用时下发（tls spec §1）。
      ...(options.tls ? { certFingerprint: options.tls.certFingerprint } : {}),
    },
  };
}

const staticMimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

// 凭证提取与比对逻辑已收拢到 server.auth 模块（adapters/tokenGuard.ts）；
// 这里只保留鉴权保护面判定，供 SPA fallback 排除受保护路径使用。

function isStaticFallbackAllowed(pathname: string): boolean {
  return !isTokenProtectedPath(pathname);
}

function isInsideDirectory(root: string, candidate: string): boolean {
  const diff = relative(root, candidate);
  return diff === "" || (!diff.startsWith("..") && !diff.includes(`..${sep}`));
}

async function resolveStaticFile(
  staticRoot: string,
  pathname: string,
  spaFallback: boolean,
): Promise<string | null> {
  const root = resolve(staticRoot);
  const normalizedPathname = pathname === "/" ? "/index.html" : pathname;
  const relativePath = decodeURIComponent(normalizedPathname).replace(/^\/+/, "");
  let candidate = resolve(root, relativePath);
  if (!isInsideDirectory(root, candidate)) {
    return null;
  }

  try {
    const candidateStat = await stat(candidate);
    if (candidateStat.isDirectory()) {
      candidate = resolve(candidate, "index.html");
      if (!isInsideDirectory(root, candidate)) {
        return null;
      }
      const indexStat = await stat(candidate);
      return indexStat.isFile() ? candidate : null;
    }
    if (candidateStat.isFile()) {
      return candidate;
    }
  } catch {
    // 静态资源未命中时再进入 SPA fallback，保留真实文件错误的 404 语义。
  }

  if (!spaFallback || !isStaticFallbackAllowed(pathname)) {
    return null;
  }
  const indexFile = resolve(root, "index.html");
  try {
    const indexStat = await stat(indexFile);
    return indexStat.isFile() ? indexFile : null;
  } catch {
    return null;
  }
}

function staticContentType(filePath: string): string {
  return staticMimeTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export function createHttpServer(
  services: ServiceCollection,
  port = 3030,
  options: HttpServerOptions = {},
) {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const hostCapabilities = createHostCapabilityStore();

  // 管理员 token 唯一解析来源（含旧环境变量兼容与告警），同时供 server-info 使用。
  const effectiveAuthToken = resolveEffectiveAuthToken(options);
  const authEnabled = Boolean(effectiveAuthToken) || Boolean(options.deviceTokenRegistry);
  const pairingEnabled = Boolean(options.pairingService && options.deviceTokenRegistry);
  const tokenGuard = createTokenGuard({
    adminToken: effectiveAuthToken,
    deviceTokenRegistry: options.deviceTokenRegistry,
    ...(pairingEnabled
      ? { adminOnlyPaths: PAIRING_ADMIN_ONLY_PATHS, publicPaths: PAIRING_PUBLIC_PATHS }
      : {}),
  });
  if (tokenGuard) {
    app.use("*", tokenGuard);
  }

  app.get("/api/server-info", (c) => c.json(createServerInfo(options, authEnabled)));
  app.post("/api/rpc-host-capability", (c) => c.json(hostCapabilities.issue()));

  if (options.pairingService && options.deviceTokenRegistry) {
    app.route(
      "/",
      createPairingRoutes({
        pairingService: options.pairingService,
        deviceRegistry: options.deviceTokenRegistry,
        serverIdentity: {
          serverId: resolveServerId(options),
          ...(options.name?.trim() ? { name: options.name.trim() } : {}),
          ...(options.tls
            ? { certFingerprint: options.tls.certFingerprint, certPem: options.tls.certPem }
            : {}),
        },
      }),
    );
  }

  // 普通 `/ws` 永远是 terminal-client；浏览器/任意客户端设置旧 mode header
  // 都不能再把自己提升为 trusted host。
  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        setupChannelServer(ws.raw as WebSocket, services, "web-remote-replayable");
      },
    })),
  );

  const upgradeTrustedHostWebSocket = upgradeWebSocket(() => ({
    onOpen(_event, ws) {
      setupChannelServer(ws.raw as WebSocket, services, "desktop-continuous");
    },
  }));
  app.use("/ws/host", async (c, next) => {
    const capability = c.req.header(ZCODE_RPC_HOST_CAPABILITY_HEADER);
    if (!hostCapabilities.consume(capability)) {
      return c.json({ error: "Invalid or expired host capability" }, 401);
    }
    await next();
  });
  app.get("/ws/host", upgradeTrustedHostWebSocket);

  // Web 模式下发起远程连接
  app.post("/api/connect-remote", async (c) => {
    const rawBody = await c.req.json();
    const parsedBody = remoteTargetSchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return c.json({ error: `Invalid request body: ${formatZodError(parsedBody.error)}` }, 400);
    }
    const body = parsedBody.data;

    try {
      const backend = await createRemoteBackend(body);
      const connection = await connectRemote(backend);
      const id = generateId();
      remoteConnections.set(id, connection);

      return c.json({ id });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // 远程连接的 WebSocket 端点，将远程 services 桥接给浏览器
  app.get(
    "/ws/remote/:id",
    upgradeWebSocket((c) => {
      const id = c.req.param("id");
      return {
        onOpen(_event, ws) {
          if (!id) {
            ws.close(4000, "Missing remote connection id");
            return;
          }
          const connection = remoteConnections.get(id);
          if (!connection) {
            ws.close(4004, "Remote connection not found");
            return;
          }
          // 一个连接只给一个 WS 客户端使用，取出后从 Map 移除
          remoteConnections.delete(id);

          // 将远程 services 包装为 ServiceCollection，复用 exposeOnChannelServer 统一注册
          const remoteServices = new ServiceCollection()
            .register(IFileService, connection.services.fileService)
            .register(IGitService, connection.services.gitService)
            .register(ISystemService, connection.services.systemService)
            .register(ITerminalService, connection.services.terminalService);

          setupChannelServer(ws.raw as WebSocket, remoteServices, "web-remote-replayable");
        },
      };
    }),
  );

  if (options.staticRoot?.trim()) {
    const staticRoot = options.staticRoot.trim();
    app.get("*", async (c) => {
      const pathname = new URL(c.req.url).pathname;
      const filePath = await resolveStaticFile(staticRoot, pathname, options.spaFallback ?? true);
      if (!filePath) {
        return c.notFound();
      }
      return c.body(await readFile(filePath), 200, {
        "Cache-Control": filePath.endsWith("index.html")
          ? "no-cache"
          : "public, max-age=31536000, immutable",
        "Content-Type": staticContentType(filePath),
      });
    });
  }

  let server: ReturnType<typeof serve>;
  if (options.tls) {
    // TLS 模式：https.createServer + getRequestListener（WSS 经 injectWebSocket 同源升级）。
    server = https.createServer(
      { cert: options.tls.certPem, key: options.tls.keyPem },
      getRequestListener(app.fetch),
    );
    server.listen(port, options.host, () => {
      const address = server.address();
      const listenPort = typeof address === "object" && address ? address.port : port;
      const listenHost = options.host?.trim() || "localhost";
      log(`https://${listenHost}:${listenPort}`);
    });
  } else {
    server = serve({ fetch: app.fetch, hostname: options.host, port }, () => {
      const address = server.address();
      const listenPort = typeof address === "object" && address ? address.port : port;
      const listenHost = options.host?.trim() || "localhost";
      log(`http://${listenHost}:${listenPort}`);
    });
  }

  injectWebSocket(server);

  return server;
}
