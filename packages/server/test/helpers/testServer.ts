/**
 * E7 测试基建：起一个临时端口的 HTTP/HTTPS server 供鉴权/配对/TLS 集成测试使用。
 * 空 ServiceCollection 即可——鉴权中间件在路由之前生效，不依赖业务服务。
 */
import { once } from "node:events";
import type { Server } from "node:http";
import { ServiceCollection } from "@zcode/services";
import { createHttpServer } from "../../src/http.js";
import type { TlsMaterial } from "../../src/tls/contract.js";

export interface TestHttpServerHandle {
  port: number;
  baseUrl: string;
  close(): Promise<void>;
}

/**
 * options.tls 提供时以 HTTPS 监听（baseUrl 为 https://，fetch 需自带跳过校验的 dispatcher）。
 */
export async function startTestHttpServer(
  options: Parameters<typeof createHttpServer>[2] = {},
): Promise<TestHttpServerHandle> {
  const services = new ServiceCollection();
  const server = createHttpServer(services, 0, options);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test http server did not listen on a tcp port");
  }
  const scheme = (options as { tls?: TlsMaterial }).tls ? "https" : "http";
  return {
    port: address.port,
    baseUrl: `${scheme}://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        (server as Server).close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
